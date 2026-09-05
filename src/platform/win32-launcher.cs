// Dupe launcher for Windows. One of these is compiled per profile with the
// @PLACEHOLDERS@ filled in, using the csc.exe that ships with .NET Framework.
//
// What it does:
//   1. Resolves the stock executable at launch time. Store (MSIX) packages
//      move to a new versioned folder on every update, so the package family
//      is looked up in the per-user AppModel repository key instead of
//      trusting a baked path.
//   2. Exports the profile's environment and starts the app with
//      --user-data-dir (plus any preset-specific flags).
//   3. Stays alive next to the app and, as its top-level windows appear,
//      stamps each one with this profile's AppUserModelID and relaunch
//      name/icon. That is what gives the profile its own taskbar group, its
//      own icon and its own pin, even though the process, the binary and the
//      AppUserModelID the app sets on itself are all shared with the stock
//      install.
//   4. `--install-shortcut` writes the Start Menu .lnk with the same
//      AppUserModelID so pinning from Start and pinning from the taskbar
//      land on the same group.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

static class Config
{
    public const string Label = @"@LABEL@";
    public const string Aumid = @"@AUMID@";
    public const string ExePath = @"@EXE_PATH@";
    public const string MsixPattern = @"@MSIX_PATTERN@";
    public const string MsixExe = @"@MSIX_EXE@";
    public const string ProfileDir = @"@PROFILE_DIR@";
    public const string Arguments = @"@ARGUMENTS@";
    public static readonly string[] EnvKeys = new string[] { @ENV_KEYS@ };
    public static readonly string[] EnvValues = new string[] { @ENV_VALUES@ };
    public static readonly string[] EnvMkdirs = new string[] { @ENV_MKDIRS@ };
}

static class Native
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int MessageBoxW(IntPtr h, string text, string caption, uint type);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadImageW(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    public const uint WM_SETICON = 0x80, IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)] public struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }
    [DllImport("shell32.dll")] public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT pvar);

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class ShellLink { }

    public static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    public const uint PID_ID = 5, PID_RELAUNCH_COMMAND = 2, PID_RELAUNCH_ICON = 3, PID_RELAUNCH_NAME = 4;

    public static int SetString(IPropertyStore ps, uint pid, string value)
    {
        PROPERTYKEY key = new PROPERTYKEY(); key.fmtid = AppUserModel; key.pid = pid;
        PROPVARIANT pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(value);
        int hr = ps.SetValue(ref key, ref pv);
        PropVariantClear(ref pv);
        return hr;
    }
}

static class Launcher
{
    static string SelfPath { get { return Process.GetCurrentProcess().MainModule.FileName; } }

    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--install-shortcut") return InstallShortcut(args.Length > 1 ? args[1] : null);
        if (args.Length > 0 && args[0] == "--resolve") { string r = ResolveExe(); Console.WriteLine(r ?? ""); return r == null ? 1 : 0; }

        string exe = ResolveExe();
        if (exe == null)
        {
            Native.MessageBoxW(IntPtr.Zero,
                "Couldn't find the stock app this profile wraps.\n\nExpected: " + (Config.MsixPattern.Length > 0 ? Config.MsixPattern + "\\" + Config.MsixExe : Config.ExePath) +
                "\n\nReinstall the app, or run `dupe rebuild` if it moved.", Config.Label, 0x10);
            return 2;
        }

        Directory.CreateDirectory(Config.ProfileDir);
        foreach (string d in Config.EnvMkdirs) Directory.CreateDirectory(d);
        for (int i = 0; i < Config.EnvKeys.Length; i++) Environment.SetEnvironmentVariable(Config.EnvKeys[i], Config.EnvValues[i]);

        StringBuilder cmd = new StringBuilder(Config.Arguments);
        foreach (string a in args) { cmd.Append(' '); cmd.Append(Quote(a)); }

        ProcessStartInfo psi = new ProcessStartInfo(exe, cmd.ToString());
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetDirectoryName(exe);
        Process root;
        try { root = Process.Start(psi); }
        catch (Exception e)
        {
            Native.MessageBoxW(IntPtr.Zero, "Couldn't start " + exe + "\n\n" + e.Message, Config.Label, 0x10);
            return 3;
        }

        TagWindowsUntilExit(root.Id);
        return 0;
    }

    static IntPtr bigIcon = IntPtr.Zero, smallIcon = IntPtr.Zero;

    static void LoadIcons()
    {
        string ico = Path.Combine(Path.GetDirectoryName(SelfPath), "icon.ico");
        if (!File.Exists(ico)) return;
        bigIcon = Native.LoadImageW(IntPtr.Zero, ico, Native.IMAGE_ICON, 256, 256, Native.LR_LOADFROMFILE);
        smallIcon = Native.LoadImageW(IntPtr.Zero, ico, Native.IMAGE_ICON, 32, 32, Native.LR_LOADFROMFILE);
    }

    // Follow the process tree (Electron main + helpers, or a Squirrel stub
    // and the real app it spawns) and stamp every new top-level window.
    static void TagWindowsUntilExit(int rootPid)
    {
        LoadIcons();
        Dictionary<IntPtr, DateTime> tagged = new Dictionary<IntPtr, DateTime>();
        DateTime start = DateTime.UtcNow;
        int quietTicks = 0;
        while (true)
        {
            HashSet<uint> pids = Descendants((uint)rootPid);
            if (pids.Count == 0)
            {
                // Give a stub a moment to hand off before concluding the app is gone.
                if (++quietTicks > 8) break;
            }
            else quietTicks = 0;

            DateTime now = DateTime.UtcNow;
            Native.EnumWindows(delegate (IntPtr h, IntPtr lp)
            {
                uint pid; Native.GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains(pid)) return true;
                if (Native.GetWindow(h, 4) != IntPtr.Zero) return true; // owned windows follow their owner
                DateTime first;
                if (!tagged.TryGetValue(h, out first)) { Tag(h); tagged[h] = now; SetIcon(h); }
                // The app may reset its icon while the window is still loading;
                // keep re-applying ours for a few seconds after first sight.
                else if ((now - first).TotalSeconds < 10) SetIcon(h);
                return true;
            }, IntPtr.Zero);

            double elapsed = (now - start).TotalSeconds;
            Thread.Sleep(elapsed < 30 ? 200 : 1000);
        }
    }

    // Identity for the taskbar: own group, own pin, own relaunch name/icon.
    static void Tag(IntPtr hwnd)
    {
        Guid iid = typeof(Native.IPropertyStore).GUID;
        Native.IPropertyStore ps;
        if (Native.SHGetPropertyStoreForWindow(hwnd, ref iid, out ps) != 0) return;
        Native.SetString(ps, Native.PID_ID, Config.Aumid);
        Native.SetString(ps, Native.PID_RELAUNCH_COMMAND, Quote(SelfPath));
        Native.SetString(ps, Native.PID_RELAUNCH_NAME, Config.Label);
        Native.SetString(ps, Native.PID_RELAUNCH_ICON, IconPath + ",0");
        ps.Commit();
    }

    static string IconPath
    {
        get
        {
            string ico = Path.Combine(Path.GetDirectoryName(SelfPath), "icon.ico");
            return File.Exists(ico) ? ico : SelfPath;
        }
    }

    // The live taskbar button, Alt-Tab and the title bar read the window's
    // own icon, so set that too.
    static void SetIcon(IntPtr hwnd)
    {
        if (bigIcon != IntPtr.Zero) Native.SendMessageW(hwnd, Native.WM_SETICON, new IntPtr(1), bigIcon);
        if (smallIcon != IntPtr.Zero) Native.SendMessageW(hwnd, Native.WM_SETICON, IntPtr.Zero, smallIcon);
    }

    static HashSet<uint> Descendants(uint rootPid)
    {
        Dictionary<uint, uint> parentOf = new Dictionary<uint, uint>();
        HashSet<uint> alive = new HashSet<uint>();
        IntPtr snap = Native.CreateToolhelp32Snapshot(2, 0);
        if (snap != IntPtr.Zero && snap != new IntPtr(-1))
        {
            Native.PROCESSENTRY32W e = new Native.PROCESSENTRY32W();
            e.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32W));
            if (Native.Process32FirstW(snap, ref e))
            {
                do { parentOf[e.th32ProcessID] = e.th32ParentProcessID; alive.Add(e.th32ProcessID); }
                while (Native.Process32NextW(snap, ref e));
            }
            Native.CloseHandle(snap);
        }
        HashSet<uint> result = new HashSet<uint>();
        if (alive.Contains(rootPid)) result.Add(rootPid);
        bool grew = true;
        while (grew)
        {
            grew = false;
            foreach (KeyValuePair<uint, uint> kv in parentOf)
            {
                if (result.Contains(kv.Value) && !result.Contains(kv.Key) && kv.Key != kv.Value) { result.Add(kv.Key); grew = true; }
            }
        }
        return result;
    }

    static string ResolveExe()
    {
        if (Config.MsixPattern.Length > 0)
        {
            string best = null; Version bestVersion = null;
            Regex rx = new Regex("^" + Regex.Escape(Config.MsixPattern).Replace("\\*", ".*") + "$", RegexOptions.IgnoreCase);
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages"))
            {
                if (k != null)
                {
                    foreach (string name in k.GetSubKeyNames())
                    {
                        if (!rx.IsMatch(name)) continue;
                        string root = null;
                        using (RegistryKey sk = k.OpenSubKey(name)) { if (sk != null) root = sk.GetValue("PackageRootFolder") as string; }
                        if (root == null) continue;
                        string candidate = Path.Combine(root, Config.MsixExe);
                        if (!File.Exists(candidate)) continue;
                        Version v = VersionOf(name);
                        if (best == null || (v != null && (bestVersion == null || v > bestVersion))) { best = candidate; bestVersion = v; }
                    }
                }
            }
            if (best != null) return best;
        }
        if (Config.ExePath.Length > 0)
        {
            if (File.Exists(Config.ExePath)) return Config.ExePath;
            // Squirrel layout: <root>\app-<version>\<exe>. Pick the newest sibling.
            string dir = Path.GetDirectoryName(Config.ExePath);
            string parent = dir == null ? null : Path.GetDirectoryName(dir);
            string exeName = Path.GetFileName(Config.ExePath);
            if (parent != null && Directory.Exists(parent))
            {
                string best = null; Version bestVersion = null;
                foreach (string d in Directory.GetDirectories(parent, "app-*"))
                {
                    string candidate = Path.Combine(d, exeName);
                    if (!File.Exists(candidate)) continue;
                    Version v; try { v = new Version(Path.GetFileName(d).Substring(4)); } catch { v = null; }
                    if (best == null || (v != null && (bestVersion == null || v > bestVersion))) { best = candidate; bestVersion = v; }
                }
                if (best != null) return best;
            }
        }
        return null;
    }

    static Version VersionOf(string packageFullName)
    {
        string[] parts = packageFullName.Split('_');
        if (parts.Length < 2) return null;
        try { return new Version(parts[1]); } catch { return null; }
    }

    static int InstallShortcut(string lnkPath)
    {
        if (lnkPath == null)
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            lnkPath = Path.Combine(programs, Config.Label + ".lnk");
        }
        Native.IShellLinkW link = (Native.IShellLinkW)new Native.ShellLink();
        link.SetPath(SelfPath);
        link.SetWorkingDirectory(Path.GetDirectoryName(SelfPath));
        link.SetIconLocation(IconPath, 0);
        link.SetDescription(Config.Label);
        Native.IPropertyStore ps = (Native.IPropertyStore)link;
        Native.SetString(ps, Native.PID_ID, Config.Aumid);
        ps.Commit();
        IPersistFile file = (IPersistFile)link;
        file.Save(lnkPath, true);
        Console.WriteLine(lnkPath);
        return 0;
    }

    static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }
}
