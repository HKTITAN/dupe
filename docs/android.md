# Android

Android can't be scripted the way the desktops can: one app can't relaunch another with flags, and only the system can put a second copy of an app on the launcher. But the platform already ships the feature this tool exists for, so the honest answer on Android is configuration, not code.

## The built-in answer: a work profile

Android's **work profile** (Android Enterprise) is a second user-space on the same phone. Apps installed into it are separate installs with separate data, separate accounts and separate notifications, and the launcher shows them with a briefcase badge on the icon. That badge is Android's "blue means work".

You do not need an employer to use it. Two open-source apps create a work profile locally, with you as the only admin:

- **Shelter** (F-Droid, GitHub: PeterCxy/Shelter) — the maintained, no-nonsense option.
- **Island** (Play Store / GitHub: oasisfeng/island) — older, similar.

Steps with Shelter:

1. Install Shelter and tap **Set up**. Android creates the work profile and asks you to confirm.
2. In Shelter's **Main** tab, long-press Claude, ChatGPT or any app and choose **Clone to work profile**.
3. Open the badged copy from the launcher's **Work** tab and sign in with the other account.
4. Optional: in Settings → Work profile, schedule the profile to pause outside working hours. Every work app goes quiet at once.

Limits: one work profile per user, so this gives you exactly two of each app. Some banking and DRM apps refuse to run in a work profile.

## More than two: OEM app cloning

Most Android OEMs ship a cloning feature that runs a second copy of an app under a hidden user. It's the same mechanism as a work profile, without the enterprise plumbing, and the number of clones depends on the vendor:

| Vendor | Setting | Notes |
| --- | --- | --- |
| Samsung | Settings → Advanced features → **Dual Messenger** | Messaging apps only, as listed by Samsung |
| Xiaomi / Poco | Settings → Apps → **Dual apps** | Most apps |
| OnePlus / Oppo / Realme | Settings → Apps → **App Cloner** | Most apps |
| Huawei / Honor | Settings → Apps → **App Twin** | Curated list |
| Google Pixel (Android 14+) | Settings → Apps → **Cloned apps** | Curated list; Google widens it per release |
| vivo / iQOO | Settings → Apps and permissions → **App Clone** | Most apps |

Cloned icons get a small numeral or badge added by the launcher; you can't recolour them without a third-party launcher.

## Recolouring icons

Launchers such as Nova, Niagara and Lawnchair let you set a custom icon per shortcut, so a work-profile or cloned app can carry a recoloured icon. Generate one with this tool:

```bash
dupe icon path/to/app-icon.png claude-work.png --color blue
```

Any 512 px PNG of the app's icon works as input (the Play Store listing image is fine). Copy the output to the phone and pick it as the custom icon.

## Multiple Android users

For fully separate desks rather than a badge, Settings → System → **Multiple users** creates whole user accounts. Each has its own home screen and apps. Switching is heavier than a work profile (it's closer to logging out), which is why the work profile is the default recommendation.
