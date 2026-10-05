# Discord backend configuration

The complete VEIL setup, browser/API route list, data-flow, deployment, and access-control guide is in the [client repository README](https://github.com/oladraxler01/discord-modified-client#readme). Backend local configuration is listed in `.env.example`; `dotenv/config` loads a local `.env`, while Render should use its Environment settings.

MongoDB and Pusher server credentials must be supplied through environment variables; they are no longer embedded in `server.js`. Rotate provider credentials that were previously present in tracked source, because old Git commits are not changed by removing them from the current file.

Group share links are scoped to the group whose invite code they contain. `GET /groups` and `GET /groups/:id` require membership, accepting `/groups/join` adds the signed-in UID only to the matched group, and direct member additions are creator-only.

## Firebase Admin for private messaging

Set `FIREBASE_SERVICE_ACCOUNT_JSON` in the backend hosting provider (Render) to the complete Firebase service-account JSON for the same Firebase project used by the frontend. Keep this value in the host's secret/environment-variable settings; do not commit the credential file or value.

The DM API and Pusher private-channel authorization fail closed until this variable is configured. The API verifies Firebase ID tokens on DM operations and checks that the verified UID belongs to the conversation before returning messages or authorizing a Pusher subscription.

## Friend requests and channel invites

The friend API generates shareable `FRIEND-XXXXXXXX` codes, stores incoming requests, and only allows starting a new DM after the recipient accepts. Channel creation is private by default. Owners create random, seven-day invite links; invitees must sign in and accept before membership is added. Channel list, reads, writes, and private Pusher authorization are restricted to the owner/members. Group listing and group membership operations also require Firebase authentication.

### Lock down channels created before private-channel support

Set `CHANNEL_MIGRATION_OWNER_UID` in Render to the Firebase UID of the account that owns the existing channels. Sign into the frontend as that account and use **Secure old** in the channel sidebar once. This one-time operation converts unclassified legacy channels to invite-only and assigns them to that UID. Until the migration is run, unclassified legacy channels are hidden/denied rather than exposed to everyone. Keep this variable private to Render configuration; it is not a credential but controls which account may run the migration.
