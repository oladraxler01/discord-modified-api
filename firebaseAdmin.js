import admin from "firebase-admin";

let initializedApp;

const getFirebaseAdmin = () => {
  if (initializedApp) return initializedApp;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);
  serviceAccount.private_key = serviceAccount.private_key?.replace(
    /\\n/g,
    "\n",
  );

  initializedApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return initializedApp;
};

export const requireFirebaseAuth = async (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  if (!token) {
    return res.status(401).json({ error: "Authentication is required." });
  }

  try {
    const app = getFirebaseAdmin();
    req.authUser = await admin.auth(app).verifyIdToken(token);
    return next();
  } catch (error) {
    if (error.message === "FIREBASE_SERVICE_ACCOUNT_JSON is not configured.") {
      return res.status(503).json({
        error:
          "Private messaging is unavailable until Firebase Admin is configured.",
      });
    }

    console.error("Firebase token verification failed:", error.message);
    return res
      .status(401)
      .json({ error: "Invalid or expired authentication token." });
  }
};

export const getFirebaseUser = async (uidOrEmail) => {
  const app = getFirebaseAdmin();
  const auth = admin.auth(app);
  const record = uidOrEmail.includes("@")
    ? await auth.getUserByEmail(uidOrEmail)
    : await auth.getUser(uidOrEmail);

  return {
    uid: record.uid,
    displayName: record.displayName || record.email || record.uid,
    email: record.email || "",
    photo: record.photoURL || "",
  };
};
