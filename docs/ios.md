# iOS and iPadOS

iOS does not allow a second copy of an App Store app, does not let one app launch another with arguments, and does not let anything change another app's icon. Nothing this tool can compile will change that. What iOS does allow is a separate, isolated **web app** per account with an icon you choose, which for Claude, ChatGPT and most other services is the same product in a different wrapper.

## Home-screen web apps: one per account

Since iOS 16.4, a site added to the Home Screen from Safari runs as its own app with its own cookie jar, local storage and push notifications, independent of Safari and of any other home-screen copy of the same site. That is exactly the isolation the desktop profiles give you.

1. In Safari, open **claude.ai** (or chatgpt.com, grok.com, etc.) and sign in with the *work* account.
2. Tap **Share** → **Add to Home Screen**.
3. Name it "Claude Work". Tap **Add**.
4. Repeat from a private tab, or after signing out, for the next account. Each copy keeps its own session.

Sign-ins do not leak between copies. Notifications work per copy on iOS 16.4+. The native app, if installed, stays as the personal profile.

## Giving the copy a coloured icon

Safari uses the site's own icon. To make the work copy blue, wrap it in a Shortcut, which lets you pick any image as the Home Screen icon:

1. Generate the icon on a computer:

   ```bash
   dupe icon path/to/claude-icon.png claude-work.png --color blue
   ```

   and send `claude-work.png` to the phone (AirDrop, Files, Photos).

2. In **Shortcuts**, create a shortcut with a single **Open URL** action pointing at `https://claude.ai`.
3. Tap the shortcut's title → **Add to Home Screen** → tap the icon → **Choose Photo** → pick the blue icon. Name it "Claude Work".

Caveat: a Shortcut opens the URL in Safari, not in the isolated web app from the previous section, so it shares Safari's session. Use the Shortcut route when the colour matters more than isolation, and the plain Add-to-Home-Screen route when the isolation matters more. (There's no supported way to get both at once as of iOS 18.)

## Native apps with account switching

Some apps have built the feature in. ChatGPT for iOS supports multiple signed-in accounts in Settings; Slack and Discord always have. Where the vendor offers it, that's the answer, and "blue means work" becomes the workspace switcher.

## What managed devices get

Apple's equivalent of Android's work profile is **User Enrollment** (iOS 13+): a managed Apple ID sits next to the personal one, with a separate APFS volume for managed apps and data. It requires an MDM, so it's an employer-provided answer rather than something you set up for yourself, and it still runs one copy of each app.
