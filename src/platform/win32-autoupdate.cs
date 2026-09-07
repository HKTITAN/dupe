// Windowless stub for the Windows auto-update task. Compiled once by
// `dupe autoupdate on` with the same csc.exe the profile launchers use.
//
// The Task Scheduler runs whatever it is given in the user's session, so a
// console program — node.exe, or the dupe binary — flashes a black window
// every few hours. This is a /target:winexe, which has no console of its
// own, and it starts the real command with CREATE_NO_WINDOW. It exits with
// the child's exit code so the task's Last Result stays meaningful.
using System;
using System.Diagnostics;

static class AutoUpdate
{
    static int Main()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(@"@COMMAND@", @"@ARGUMENTS@");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception)
        {
            return 1;
        }
    }
}
