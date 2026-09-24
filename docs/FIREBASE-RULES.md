# Firebase security rules: ownership boundary

Dubly runs in the Firebase project `scatter-studio-live-2026`, which it **shares with ScatterStudio** for Auth, Firestore and the Storage bucket. A rules deploy (`firebase deploy --only firestore:rules` or `storage`) replaces the rules for the **whole project**. A deploy from this repo would therefore overwrite ScatterStudio's rules.

## What this repo does

- `firebase.json` contains **only emulator settings**. It has no `firestore` or `storage` rules entries, so `firebase deploy` from this repo can't change production rules.
- `firebase.test.json` is used only by `npm test` to start the local emulators. The rules file it names (`firebase/emulator-only.storage.rules`) must never be deployed.
- `firebase/dubly.firestore.rules` and `firebase/dubly.storage.rules` are **reference fragments**. They list every path Dubly owns and deny all client access to them.

## Why every Dubly path can be closed to clients

- The Dubly backend uses the Admin SDK, which ignores rules.
- The Dubly frontend never reads or writes Firestore or Storage directly. It calls `/api/*` and receives media only as signed URLs.

## What the ScatterStudio rules owner needs to do (manual, not done by this repo)

1. Merge the fragments' `match` blocks into ScatterStudio's rules.
2. **Check for broad rules that re-open Dubly paths.** Firestore and Storage *OR* matching rules together, so a deny can't override an allow. The old rules in this repo contained `match /users/{uid}/{document=**} { allow read, write: if request.auth.uid == uid; }`. If ScatterStudio's deployed rules have that (or something similar), users can write their own `users/{uid}/voices/*` documents and upload straight into the bucket. That broad rule has to be narrowed to the specific paths ScatterStudio needs.
3. Deploy from the ScatterStudio repo, then record the deployed version here.

## Defence in depth on the server (already implemented)

Even if a client could write a voice document, the server only uses a voice whose `sampleStoragePath` is exactly `users/{caller uid}/voices/{uuid}/sample.wav`. See `isOwnVoiceSamplePath` in `server/lib/customVoices.ts`. Voices that fail this check are left out of listings and synthesis, and are never used to sign a URL or download a file.

| Deployed-rules check | Status |
|---|---|
| Deployed Firestore rules reviewed for broad `users/{uid}/**` allows | **Needs Firebase console access** |
| Deployed Storage rules reviewed for client writes under `users/` or `workspaces/` | **Needs Firebase console access** |
