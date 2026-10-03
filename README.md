# Discord backend configuration

## Firebase Admin for private messaging

Set `FIREBASE_SERVICE_ACCOUNT_JSON` in the backend hosting provider (Render) to the complete Firebase service-account JSON for the same Firebase project used by the frontend. Keep this value in the host's secret/environment-variable settings; do not commit the credential file or value.

The DM API and Pusher private-channel authorization fail closed until this variable is configured. The API verifies Firebase ID tokens on DM operations and checks that the verified UID belongs to the conversation before returning messages or authorizing a Pusher subscription.
