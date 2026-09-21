# Getting Drift-O-Mania onto your iPhone

Written for someone who does not write code. Every command is copy-and-paste. Nothing here is
reversible in a way that costs money except step 1, which is Apple's $99/year fee.

You will be at the point where the app is on your phone in about **two hours of waiting and
fifteen minutes of doing**, spread over a day or two while Apple approves things.

---

## Before you start: two accounts

**1. Apple Developer Program — $99/year.** <https://developer.apple.com/programs/enroll/>

This is the only thing that costs money and the only thing that can take days. Apple sometimes
approves in an hour and sometimes asks for ID and takes two days. Start this first and do
everything else while you wait. You cannot put an app on a phone without it.

**2. An Expo account — free.** <https://expo.dev/signup>

Expo owns the Mac computers that will build the app for you. The machine this project was
written on runs Linux, and only a Mac can turn an iPhone app into something an iPhone will
install. Expo's build service is the way around that without buying a Mac.

---

## Getting the code onto your computer

You need three things installed. All three are normal installers, no terminal required.

1. **Node.js** — <https://nodejs.org> — download the one marked **LTS** and run it.
2. **Git** — Mac users already have it. Windows: <https://git-scm.com/download/win>, click
   through with all the defaults.
3. Nothing else.

Then open a terminal (Mac: **Terminal**, in Applications → Utilities. Windows: **Git Bash**,
which the Git installer put in your Start menu) and paste these one line at a time:

```bash
# The repository is still called drift-o-meter; only the app was renamed.
git clone https://github.com/scriptedfantasy/drift-o-meter.git
cd drift-o-meter
git checkout claude/quirky-hopper-cfu8ng
npm install
```

The last one takes a few minutes and prints a lot of text. Text is fine. Only stop if it says
`ERROR` and then stops.

---

## Building it

Still in the same terminal window, in the same folder:

```bash
npx eas-cli@latest login
```

Your Expo email and password. Then:

```bash
npx eas-cli@latest init
```

This links the folder to your Expo account and writes an ID into `app.json`. Say yes to
everything it asks.

```bash
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

**This is the one that does the work.** It will ask you several questions:

| It asks | You say |
| --- | --- |
| Apple ID | your Apple ID email |
| Password, then a 6-digit code | from your Mac or iPhone |
| "Generate a new Apple Distribution Certificate?" | **Yes** |
| "Generate a new Apple Provisioning Profile?" | **Yes** |
| "Would you like to create an App Store Connect app?" | **Yes** |

Then it builds. **This takes 15–30 minutes** and you can close the laptop; the build is happening
on Expo's machines, not yours. `--auto-submit` means it hands the finished app to Apple by itself
when it is done, so there is no second command to run.

You are not expected to understand anything it prints.

---

## Getting it onto the phone

1. Apple needs **5 to 20 minutes** to process the upload. You get an email when it is done.
2. Go to <https://appstoreconnect.apple.com> → **My Apps** → Drift-O-Mania → **TestFlight**.
3. There may be a yellow "Missing Compliance" warning. There should not be — `app.json` already
   declares `ITSAppUsesNonExemptEncryption: false` — but if it appears, click it and answer
   **No** to "does your app use encryption".
4. Left sidebar → **Internal Testing** → **+** → make a group, call it anything → add yourself by
   the Apple ID email you use on your iPhone.
5. On the iPhone, install **TestFlight** from the App Store. Open the invite email on the phone,
   tap **View in TestFlight**, tap **Install**.

Internal testers do not wait for review. The app is on your phone as soon as Apple finishes
processing. (External testers — friends — need a one-time Beta App Review, usually a day.)

---

## Later builds

Once the above has worked once, every future version is one command:

```bash
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

No questions the second time. `eas.json` sets `autoIncrement`, so the build number goes up by
itself and Apple will not reject the upload as a duplicate.

---

## What to expect the first time you drive with it

**This has never run on a phone.** Every screenshot in this project so far is the real app,
really rendering, really running the engine — but exported for web and photographed in a headless
browser on a Linux machine, fed by a simulated car. The engine is pure TypeScript and 762 tests
cover it. What no test on that machine can cover is the phone itself.

`docs/ARCHITECTURE.md` keeps the list under **"What only a phone can settle"**. The short version
of what to watch for on the first drive:

- **Which way is which.** iOS reports motion in its own axes and the app converts them
  (`src/platform/deviceConvert.ts`). If a left-hand slide draws to the right, that conversion has
  a sign backwards. It is a one-line fix, but only a real car can find it.
- **The forward axis.** The app works out which way the car points from your first hard
  acceleration, while driving. Whether that actually resolves in a real car, on a real road, in
  30 seconds, is unknown.
- **Permission prompts.** The app will ask for Motion and Location the first time. If it asks and
  then does nothing, that is a bug worth reporting rather than a phone problem.
- **Timing.** The engine expects roughly 100 samples a second. Real iOS delivery is not perfectly
  even and the app is written to tolerate that, but it has never been measured against the real
  thing.

**Treat the first drive as a test of the app, not of your driving.** Somewhere safe and legal, a
few deliberate slides, then look at what the results screen says and whether it matches what the
car actually did. Bring the numbers back and they can be fixed.

---

## If something goes wrong

Copy the whole error and bring it back. Almost every failure at this stage is one of four things:
a missing Apple Developer membership, an expired certificate, a bundle identifier already taken
by someone else (`com.driftometer.app` — if Apple says it is in use, any other reverse-domain
string works), or a version number Apple has already seen. All four are quick to fix and none of
them means the app is broken.
