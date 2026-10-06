import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import { randomBytes } from "crypto";
import mongoData from "./mongoData.js";
import Pusher from "pusher";
import { getFirebaseUser, requireFirebaseAuth } from "./firebaseAdmin.js";
import { AccessToken } from "livekit-server-sdk";

//app config//
const app = express();
const port = process.env.PORT || 8002;

const pusherSettings = {
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
};
const pusher = Object.values(pusherSettings).every(Boolean)
  ? new Pusher({ ...pusherSettings, useTLS: true })
  : null;

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  inviteCode: { type: String, required: true, unique: true },
  creator: {
    displayName: String,
    email: String,
    photo: String,
    uid: String,
  },
  members: [
    {
      displayName: String,
      email: String,
      photo: String,
      uid: String,
    },
  ],
  createdAt: { type: Date, default: Date.now },
});

const Group = mongoose.models.Group || mongoose.model("Group", groupSchema);

const profileSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  friendCode: { type: String, required: true, unique: true },
  friends: { type: [String], default: [] },
});
const FriendProfile =
  mongoose.models.FriendProfile ||
  mongoose.model("FriendProfile", profileSchema);

const friendRequestSchema = new mongoose.Schema(
  {
    senderUid: { type: String, required: true },
    recipientUid: { type: String, required: true },
    pairKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "accepted"], default: "pending" },
  },
  { timestamps: true },
);
const FriendRequest =
  mongoose.models.FriendRequest ||
  mongoose.model("FriendRequest", friendRequestSchema);

const channelInviteSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    createdByUid: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);
const ChannelInvite =
  mongoose.models.ChannelInvite ||
  mongoose.model("ChannelInvite", channelInviteSchema);

const generateInviteCode = () => randomBytes(12).toString("hex").toUpperCase();

const createFriendCode = () =>
  `FRIEND-${randomBytes(4).toString("hex").toUpperCase()}`;

const ensureFriendProfile = async (uid) => {
  let profile = await FriendProfile.findOne({ uid });
  if (profile) return profile;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await FriendProfile.create({
        uid,
        friendCode: createFriendCode(),
      });
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.friendCode) continue;
      if (error.code === 11000) return FriendProfile.findOne({ uid });
      throw error;
    }
  }

  throw new Error("Could not allocate a unique friend code.");
};

const getPublicProfile = async (uid) => {
  const [friendProfile, firebaseUser] = await Promise.all([
    FriendProfile.findOne({ uid }).select("uid"),
    getFirebaseUser(uid),
  ]);
  if (!friendProfile) return null;
  return {
    uid,
    displayName: firebaseUser.displayName,
    photo: firebaseUser.photo,
  };
};

const canAccessChannel = (channel, uid) =>
  Boolean(
    channel &&
    channel.type !== "dm" &&
    (channel.accessMode === "public" ||
      (channel.accessMode === "invite" &&
        (channel.ownerUid === uid || channel.memberUids?.includes(uid)))),
  );

const canAccessConversation = (conversation, uid) => {
  if (conversation?.type === "dm") {
    return Boolean(conversation.participantIds?.includes(uid));
  }
  if (Array.isArray(conversation?.members)) {
    return conversation.members.some((member) => member.uid === uid);
  }
  return canAccessChannel(conversation, uid);
};

const channelVisibilityFor = (uid) => ({
  type: { $ne: "dm" },
  $or: [
    { accessMode: "public" },
    { accessMode: "invite", ownerUid: uid },
    { accessMode: "invite", memberUids: uid },
  ],
});

const conversationVisibilityFor = (uid) => ({
  $or: [{ type: "dm", participantIds: uid }, channelVisibilityFor(uid)],
});

//middleware config//
app.use(
  express.json({
    limit: "25mb",
    strict: true,
    type: ["application/json", "application/*+json"],
  }),
);
app.use(express.urlencoded({ extended: false, limit: "25mb" }));
app.use(cors());

//DB config//
const mongoURI = process.env.MONGO_URI;

let changeStream;

const startConversationWatch = async () => {
  if (mongoose.connection.readyState !== 1 || changeStream || !pusher) return;

  const stream = await mongoose.connection.collection("conversations").watch();
  changeStream = stream;

  stream.on("change", async (change) => {
    try {
      if (change.operationType === "insert") {
        if (pusher) await pusher.trigger("channels", "newChannel", {});
        return;
      }

      if (change.operationType !== "update" || !change.documentKey?._id) return;

      const conversation = await mongoData
        .findById(change.documentKey._id)
        .select("type accessMode");
      if (!conversation) return;

      const roomId = conversation._id.toString();
      const pusherChannel =
        conversation.type === "dm"
          ? `private-dm-${roomId}`
          : conversation.accessMode === "invite"
            ? `private-room-${roomId}`
            : `chat-${roomId}`;

      // Clients refetch through an authorized API; never broadcast message contents.
      if (pusher) await pusher.trigger(pusherChannel, "newMessage", { roomId });
    } catch (error) {
      console.error("Pusher notification failed:", error.message);
    }
  });

  stream.on("error", (error) => {
    console.error("MongoDB change stream interrupted:", error.message);
    if (changeStream === stream) changeStream = null;
    stream.close().catch(() => {});
  });

  stream.on("close", () => {
    if (changeStream === stream) changeStream = null;
  });
};

mongoose.connection.on("connected", () => {
  console.log("Connected to MongoDB");
  startConversationWatch().catch((error) => {
    console.error("Could not start MongoDB change stream:", error.message);
  });
});

mongoose.connection.on("error", (error) => {
  console.error("MongoDB connection error:", error.message);
});

if (mongoURI) {
  mongoose.connect(mongoURI).catch((error) => {
    console.error("MongoDB initial connection failed:", error.message);
  });
} else {
  console.error(
    "MONGO_URI is not configured; database routes will remain unavailable.",
  );
}

//api routes//
app.get("/", (req, res) => res.status(200).send("hello World!"));

app.post("/groups", requireFirebaseAuth, async (req, res) => {
  try {
    const name = String(req.body.name || "")
      .trim()
      .slice(0, 80);
    const creator = await getFirebaseUser(req.authUser.uid);

    if (!name || !creator?.uid) {
      return res
        .status(400)
        .json({ error: "Group name and creator are required." });
    }

    let inviteCode = generateInviteCode();
    let existing = await Group.findOne({ inviteCode });

    while (existing) {
      inviteCode = generateInviteCode();
      existing = await Group.findOne({ inviteCode });
    }

    const newGroup = await Group.create({
      name,
      inviteCode,
      creator,
      members: [creator],
    });

    return res.status(201).json(newGroup);
  } catch (error) {
    console.error("Group creation failed:", error.message);
    return res.status(500).json({ error: "Could not create group." });
  }
});

app.get("/groups", requireFirebaseAuth, async (req, res) => {
  try {
    const groups = await Group.find({ "members.uid": req.authUser.uid }).sort({
      createdAt: -1,
    });
    for (const group of groups) {
      if (!/^[A-F0-9]{24}$/.test(group.inviteCode || "")) {
        let inviteCode = generateInviteCode();
        while (await Group.exists({ inviteCode })) {
          inviteCode = generateInviteCode();
        }
        group.inviteCode = inviteCode;
        await group.save();
      }
    }
    return res.status(200).json(groups);
  } catch (error) {
    console.error("Group fetch failed:", error.message);
    return res.status(500).json({ error: "Could not load groups." });
  }
});

app.get("/groups/:id", requireFirebaseAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Group not found." });
    }
    const group = await Group.findOne({
      _id: req.params.id,
      "members.uid": req.authUser.uid,
    }).select("name inviteCode creator members createdAt");
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }
    return res.json(group);
  } catch (error) {
    console.error("Group detail request failed:", error.message);
    return res.status(500).json({ error: "Could not load this group." });
  }
});

app.get("/group-invites/:inviteCode", requireFirebaseAuth, async (req, res) => {
  try {
    const inviteCode = String(req.params.inviteCode || "")
      .trim()
      .toUpperCase();
    const group = await Group.findOne({ inviteCode }).select(
      "_id name creator members.uid",
    );
    if (!group) {
      return res.status(404).json({ error: "This group invite is invalid." });
    }
    return res.json({
      id: group._id,
      name: group.name,
      creatorName: group.creator?.displayName || "Group owner",
      isMember: group.members.some((member) => member.uid === req.authUser.uid),
    });
  } catch (error) {
    console.error("Group invite lookup failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not validate this group invite." });
  }
});

app.post("/groups/join", requireFirebaseAuth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    const user = await getFirebaseUser(req.authUser.uid);

    if (!inviteCode || !user?.uid) {
      return res
        .status(400)
        .json({ error: "Invite code and user are required." });
    }

    const group = await Group.findOne({ inviteCode });

    if (!group) {
      return res.status(404).json({ error: "Invite code not found." });
    }

    const alreadyMember = group.members.some(
      (member) => member.uid === user.uid,
    );
    if (!alreadyMember) {
      group.members.push(user);
      await group.save();
    }

    return res.status(200).json(group);
  } catch (error) {
    console.error("Group join failed:", error.message);
    return res.status(500).json({ error: "Could not join group." });
  }
});

app.post("/groups/:id/members", requireFirebaseAuth, async (req, res) => {
  try {
    const { member: memberInput } = req.body;
    if (!memberInput?.uid && !memberInput?.email) {
      return res.status(400).json({ error: "Member details are required." });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    if (group.creator?.uid !== req.authUser.uid) {
      return res
        .status(403)
        .json({ error: "Only the group creator can add members." });
    }

    const member = await getFirebaseUser(memberInput.uid || memberInput.email);

    const alreadyMember = group.members.some((currentMember) => {
      if (member.uid && currentMember.uid === member.uid) return true;
      if (member.email && currentMember.email === member.email) return true;
      return false;
    });

    if (!alreadyMember) {
      group.members.push(member);
      await group.save();
    }

    return res.status(200).json(group);
  } catch (error) {
    console.error("Add member failed:", error.message);
    return res.status(500).json({ error: "Could not add member." });
  }
});

app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "Database is temporarily unavailable. Please retry shortly.",
    });
  }
  next();
});

app.get("/friends", requireFirebaseAuth, async (req, res) => {
  try {
    const profile = await ensureFriendProfile(req.authUser.uid);
    const [friendProfiles, incoming] = await Promise.all([
      FriendProfile.find({ uid: { $in: profile.friends } }).select("uid"),
      FriendRequest.find({ recipientUid: req.authUser.uid, status: "pending" })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const [friends, incomingRequests] = await Promise.all([
      Promise.all(friendProfiles.map((friend) => getPublicProfile(friend.uid))),
      Promise.all(
        incoming.map(async (request) => ({
          id: request._id,
          sender: await getPublicProfile(request.senderUid),
          createdAt: request.createdAt,
        })),
      ),
    ]);

    return res.json({
      friendCode: profile.friendCode,
      friends: friends.filter(Boolean),
      incomingRequests: incomingRequests.filter((request) => request.sender),
    });
  } catch (error) {
    console.error("Friend list request failed:", error.message);
    return res.status(500).json({ error: "Could not load friends." });
  }
});

app.post("/friend-requests", requireFirebaseAuth, async (req, res) => {
  try {
    const friendCode = String(req.body.friendCode || "")
      .trim()
      .toUpperCase();
    if (!/^FRIEND-[A-F0-9]{8}$/.test(friendCode)) {
      return res.status(400).json({ error: "Enter a valid friend code." });
    }

    const [sender, recipient] = await Promise.all([
      ensureFriendProfile(req.authUser.uid),
      FriendProfile.findOne({ friendCode }),
    ]);
    if (!recipient)
      return res.status(404).json({ error: "Friend code not found." });
    if (recipient.uid === req.authUser.uid) {
      return res.status(400).json({ error: "You cannot add yourself." });
    }
    if (sender.friends.includes(recipient.uid)) {
      return res.status(409).json({ error: "You are already friends." });
    }

    const pairKey = [req.authUser.uid, recipient.uid].sort().join(":");
    const existing = await FriendRequest.findOne({ pairKey });
    if (existing?.status === "accepted") {
      return res.status(409).json({ error: "You are already friends." });
    }
    if (existing) {
      return res.status(409).json({
        error:
          existing.senderUid === req.authUser.uid
            ? "Friend request already sent."
            : "This person already sent you a request; accept it from Incoming requests.",
      });
    }

    const request = await FriendRequest.create({
      senderUid: req.authUser.uid,
      recipientUid: recipient.uid,
      pairKey,
      status: "pending",
    });

    return res.status(201).json({ id: request._id, status: request.status });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "A request already exists." });
    }
    console.error("Friend request creation failed:", error.message);
    return res.status(500).json({ error: "Could not send friend request." });
  }
});

app.post(
  "/friend-requests/:id/accept",
  requireFirebaseAuth,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ error: "Friend request not found." });
      }

      const request = await FriendRequest.findOneAndUpdate(
        {
          _id: req.params.id,
          recipientUid: req.authUser.uid,
          status: "pending",
        },
        { $set: { status: "accepted" } },
        { new: true },
      );
      if (!request) {
        return res
          .status(404)
          .json({ error: "Pending friend request not found." });
      }

      await Promise.all([
        FriendProfile.updateOne(
          { uid: request.senderUid },
          { $addToSet: { friends: request.recipientUid } },
        ),
        FriendProfile.updateOne(
          { uid: request.recipientUid },
          { $addToSet: { friends: request.senderUid } },
        ),
      ]);

      return res.json({ ok: true });
    } catch (error) {
      console.error("Friend request acceptance failed:", error.message);
      return res
        .status(500)
        .json({ error: "Could not accept friend request." });
    }
  },
);

app.post("/channels/:id/invites", requireFirebaseAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Channel not found." });
    }

    const channel = await mongoData.findOne({
      _id: req.params.id,
      type: { $ne: "dm" },
      accessMode: "invite",
      ownerUid: req.authUser.uid,
    });
    if (!channel) {
      return res
        .status(403)
        .json({ error: "Only the channel owner can create invites." });
    }

    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await ChannelInvite.create({
      token,
      channelId: channel._id,
      createdByUid: req.authUser.uid,
      expiresAt,
    });

    return res.status(201).json({
      token,
      channelName: channel.channelName,
      expiresAt,
    });
  } catch (error) {
    console.error("Channel invite creation failed:", error.message);
    return res.status(500).json({ error: "Could not create channel invite." });
  }
});

app.post("/channels/migrate-legacy", requireFirebaseAuth, async (req, res) => {
  try {
    const migrationOwnerUid = process.env.CHANNEL_MIGRATION_OWNER_UID;
    if (!migrationOwnerUid || req.authUser.uid !== migrationOwnerUid) {
      return res.status(403).json({
        error:
          "Legacy channel migration is restricted to the configured channel owner.",
      });
    }

    const owner = await getFirebaseUser(req.authUser.uid);
    const result = await mongoData.updateMany(
      {
        type: { $ne: "dm" },
        accessMode: { $exists: false },
      },
      {
        $set: {
          type: "channel",
          accessMode: "invite",
          ownerUid: req.authUser.uid,
          owner,
          memberUids: [req.authUser.uid],
        },
      },
    );

    return res.json({ securedCount: result.modifiedCount });
  } catch (error) {
    console.error("Legacy channel migration failed:", error.message);
    return res.status(500).json({ error: "Could not secure legacy channels." });
  }
});

app.get("/channel-invites/:token", async (req, res) => {
  try {
    const invite = await ChannelInvite.findOne({
      token: req.params.token,
      expiresAt: { $gt: new Date() },
    }).select("channelId expiresAt");
    if (!invite)
      return res.status(404).json({ error: "Invite is invalid or expired." });

    const channel = await mongoData
      .findOne({ _id: invite.channelId, type: { $ne: "dm" } })
      .select("channelName accessMode");
    if (!channel || channel.accessMode !== "invite") {
      return res.status(404).json({ error: "Invited channel is unavailable." });
    }

    return res.json({
      channelName: channel.channelName,
      expiresAt: invite.expiresAt,
    });
  } catch (error) {
    console.error("Channel invite lookup failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not validate channel invite." });
  }
});

app.post(
  "/channel-invites/:token/accept",
  requireFirebaseAuth,
  async (req, res) => {
    try {
      const invite = await ChannelInvite.findOne({
        token: req.params.token,
        expiresAt: { $gt: new Date() },
      });
      if (!invite)
        return res.status(404).json({ error: "Invite is invalid or expired." });

      const channel = await mongoData.findOneAndUpdate(
        { _id: invite.channelId, type: { $ne: "dm" }, accessMode: "invite" },
        { $addToSet: { memberUids: req.authUser.uid } },
        { new: true },
      );
      if (!channel)
        return res
          .status(404)
          .json({ error: "Invited channel is unavailable." });

      return res.json({ id: channel._id, name: channel.channelName });
    } catch (error) {
      console.error("Channel invite acceptance failed:", error.message);
      return res.status(500).json({ error: "Could not join invited channel." });
    }
  },
);

app.post("/pusher/auth", requireFirebaseAuth, async (req, res) => {
  try {
    if (!pusher) {
      return res
        .status(503)
        .json({ error: "Real-time messaging is not configured." });
    }
    const { socket_id: socketId, channel_name: channelName } = req.body;
    const dmMatch = /^private-dm-([a-f\d]{24})$/i.exec(channelName || "");
    const privateRoomMatch = /^private-room-([a-f\d]{24})$/i.exec(
      channelName || "",
    );

    if (!socketId || (!dmMatch && !privateRoomMatch)) {
      return res
        .status(400)
        .json({ error: "Invalid private channel request." });
    }

    const conversation = dmMatch
      ? await mongoData.findOne({
          _id: dmMatch[1],
          type: "dm",
          participantIds: req.authUser.uid,
        })
      : await mongoData.findOne({
          _id: privateRoomMatch[1],
          type: { $ne: "dm" },
          accessMode: "invite",
          $or: [
            { ownerUid: req.authUser.uid },
            { memberUids: req.authUser.uid },
          ],
        });

    if (!conversation) {
      return res
        .status(403)
        .json({ error: "You do not have access to this private channel." });
    }

    return res.json(pusher.authorizeChannel(socketId, channelName));
  } catch (error) {
    console.error("Private Pusher authorization failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not authorize private channel." });
  }
});

app.get("/dm", requireFirebaseAuth, async (req, res) => {
  try {
    const conversations = await mongoData
      .find({ type: "dm", participantIds: req.authUser.uid })
      .select("_id participants conversation")
      .sort({ updatedAt: -1, _id: -1 });

    return res.json(
      conversations.map((conversation) => {
        const otherParticipant = conversation.participants.find(
          (participant) => participant.uid !== req.authUser.uid,
        );
        const latestMessage = conversation.conversation.slice(-1)[0];

        return {
          id: conversation._id,
          otherParticipant,
          latestMessage: latestMessage
            ? {
                message: latestMessage.message,
                timestamp: latestMessage.timestamp,
              }
            : null,
        };
      }),
    );
  } catch (error) {
    console.error("DM list request failed:", error.message);
    return res.status(500).json({ error: "Could not load direct messages." });
  }
});

app.post("/dm", requireFirebaseAuth, async (req, res) => {
  try {
    const recipientInput = String(req.body.recipient || "").trim();
    if (!recipientInput) {
      return res
        .status(400)
        .json({ error: "A recipient UID or email is required." });
    }

    const [creator, recipient] = await Promise.all([
      getFirebaseUser(req.authUser.uid),
      getFirebaseUser(recipientInput),
    ]);

    if (creator.uid === recipient.uid) {
      return res
        .status(400)
        .json({ error: "You cannot start a DM with yourself." });
    }

    const [creatorProfile, recipientProfile] = await Promise.all([
      FriendProfile.findOne({ uid: creator.uid }),
      FriendProfile.findOne({ uid: recipient.uid }),
    ]);
    if (
      !creatorProfile?.friends.includes(recipient.uid) ||
      !recipientProfile?.friends.includes(creator.uid)
    ) {
      return res.status(403).json({
        error: "Add and accept each other as friends before starting a DM.",
      });
    }

    const participantIds = [creator.uid, recipient.uid].sort();
    const dmKey = participantIds.join(":");
    let conversation;

    try {
      conversation = await mongoData.findOneAndUpdate(
        { dmKey },
        {
          $setOnInsert: {
            type: "dm",
            dmKey,
            participantIds,
            participants: [creator, recipient],
            conversation: [],
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      conversation = await mongoData.findOne({ dmKey, type: "dm" });
    }

    return res.status(200).json({
      id: conversation._id,
      otherParticipant: conversation.participants.find(
        (participant) => participant.uid !== creator.uid,
      ),
    });
  } catch (error) {
    if (
      error.code === "auth/user-not-found" ||
      error.code === "auth/invalid-email"
    ) {
      return res.status(404).json({ error: "Firebase user was not found." });
    }

    console.error("DM creation failed:", error.message);
    return res.status(500).json({ error: "Could not start direct message." });
  }
});

app.get("/dm/:id", requireFirebaseAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Direct message not found." });
    }

    const conversation = await mongoData.findOne({
      _id: req.params.id,
      type: "dm",
      participantIds: req.authUser.uid,
    });

    if (!conversation) {
      return res.status(404).json({ error: "Direct message not found." });
    }

    return res.json({
      id: conversation._id,
      otherParticipant: conversation.participants.find(
        (participant) => participant.uid !== req.authUser.uid,
      ),
      conversation: conversation.conversation,
    });
  } catch (error) {
    console.error("DM fetch failed:", error.message);
    return res.status(500).json({ error: "Could not load direct message." });
  }
});

app.post("/dm/:id/messages", requireFirebaseAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Direct message not found." });
    }

    const conversation = await mongoData.findOne({
      _id: req.params.id,
      type: "dm",
      participantIds: req.authUser.uid,
    });
    if (!conversation) {
      return res.status(404).json({ error: "Direct message not found." });
    }

    const text =
      typeof req.body.message === "string" ? req.body.message.trim() : "";
    const voiceData =
      typeof req.body.voiceData === "string" ? req.body.voiceData : "";
    const attachment =
      req.body.attachment && typeof req.body.attachment === "object"
        ? req.body.attachment
        : null;

    if (!text && !voiceData && !attachment) {
      return res
        .status(400)
        .json({ error: "A message, voice note, or file is required." });
    }

    const sender = {
      uid: req.authUser.uid,
      displayName: req.authUser.name || req.authUser.email || "User",
      email: req.authUser.email || "",
      photo: req.authUser.picture || "",
    };

    const finalMessage =
      text ||
      (attachment
        ? `📎 ${attachment.name || "Shared a file"}`
        : "🎤 Voice note");

    const result = await mongoData.updateOne(
      {
        _id: req.params.id,
        type: "dm",
        participantIds: req.authUser.uid,
      },
      {
        $push: {
          conversation: {
            message: finalMessage,
            timestamp: new Date().toISOString(),
            voiceData: voiceData || undefined,
            attachment: attachment || undefined,
            expireAt: conversation.ephemeralSettings?.active
              ? new Date(
                  Date.now() +
                    conversation.ephemeralSettings.durationInSeconds * 1000,
                )
              : undefined,
            user: sender,
          },
        },
      },
    );

    if (!result.matchedCount) {
      return res.status(404).json({ error: "Direct message not found." });
    }

    return res.status(201).json({ ok: true });
  } catch (error) {
    console.error("DM message save failed:", error.message);
    return res.status(500).json({ error: "Could not save direct message." });
  }
});

// Create a new channel
app.post("/new/channel", requireFirebaseAuth, async (req, res) => {
  try {
    const channelName = String(req.body.channelName || "").trim();
    if (!channelName) {
      return res.status(400).json({ error: "Channel name is required." });
    }

    const owner = await getFirebaseUser(req.authUser.uid);
    const dbData = {
      channelName: channelName.slice(0, 80),
      type: "channel",
      accessMode: "invite",
      ownerUid: req.authUser.uid,
      memberUids: [req.authUser.uid],
      owner,
    };
    const data = await mongoData.create(dbData);
    return res.status(201).json({
      id: data._id,
      name: data.channelName,
      isPrivate: true,
      isOwner: true,
    });
  } catch (err) {
    console.error("Channel creation failed:", err.message);
    res.status(503).json({
      error:
        "Could not create channel. Check the database connection and retry.",
    });
  }
});

// Get the list of channels
app.get("/get/channelList", requireFirebaseAuth, async (req, res) => {
  try {
    const data = await mongoData
      .find(channelVisibilityFor(req.authUser.uid))
      .select("channelName type accessMode ownerUid")
      .lean();

    return res.status(200).json(
      data.map((channelData) => ({
        id: channelData._id,
        name: channelData.channelName,
        isPrivate:
          channelData.type != null && channelData.accessMode === "invite",
        isOwner: channelData.ownerUid === req.authUser.uid,
      })),
    );
  } catch (err) {
    console.error("Channel list request failed:", err.message);
    res.status(503).json({
      error:
        "Could not load channels. Check the database connection and retry.",
    });
  }
});

// Add a new message to a conversation
app.post("/new/message", requireFirebaseAuth, async (req, res) => {
  try {
    const conversation = await mongoData.findOne({
      _id: req.query.id,
      ...channelVisibilityFor(req.authUser.uid),
    });
    if (!conversation)
      return res.status(404).json({ error: "Channel not found." });

    const text =
      typeof req.body.message === "string" ? req.body.message.trim() : "";
    const voiceData =
      typeof req.body.voiceData === "string" ? req.body.voiceData : "";
    const attachment =
      req.body.attachment && typeof req.body.attachment === "object"
        ? req.body.attachment
        : null;
    if (!text && !voiceData && !attachment) {
      return res
        .status(400)
        .json({ error: "A message, voice note, or file is required." });
    }

    const sender = {
      uid: req.authUser.uid,
      displayName: req.authUser.name || req.authUser.email || "User",
      email: req.authUser.email || "",
      photo: req.authUser.picture || "",
    };

    const finalMessage =
      text ||
      (attachment
        ? `📎 ${attachment.name || "Shared a file"}`
        : "🎤 Voice note");

    const data = await mongoData.updateOne(
      { _id: req.query.id, ...channelVisibilityFor(req.authUser.uid) },
      {
        $push: {
          conversation: {
            message: finalMessage,
            timestamp: new Date().toISOString(),
            voiceData: voiceData || undefined,
            attachment: attachment || undefined,
            expireAt: conversation.ephemeralSettings?.active
              ? new Date(
                  Date.now() +
                    conversation.ephemeralSettings.durationInSeconds * 1000,
                )
              : undefined,
            user: sender,
          },
        },
      },
    );
    if (!data.matchedCount)
      return res.status(404).json({ error: "Channel not found." });
    return res.status(201).json(data);
  } catch (err) {
    console.error("Message save failed:", err.message);
    res.status(503).json({
      error: "Could not save message. Check the database connection and retry.",
    });
  }
});

// Get all data
app.get("/get/data", requireFirebaseAuth, async (req, res) => {
  try {
    const data = await mongoData.find(channelVisibilityFor(req.authUser.uid));
    return res.status(200).send(data);
  } catch (err) {
    console.error("Data request failed:", err.message);
    res.status(503).json({
      error: "Could not load data. Check the database connection and retry.",
    });
  }
});

// Get a specific conversation
app.get("/get/conversation", requireFirebaseAuth, async (req, res) => {
  try {
    const channel = await mongoData.findOne({
      _id: req.query.id,
      ...channelVisibilityFor(req.authUser.uid),
    });
    if (!channel) {
      return res.status(404).json({ error: "Channel not found." });
    }
    return res.status(200).json([channel]);
  } catch (err) {
    console.error("Conversation request failed:", err.message);
    res.status(503).json({
      error:
        "Could not load conversation. Check the database connection and retry.",
    });
  }
});

// GENERATE LIVEKIT VOICE TOKEN
app.post("/api/voice/token", requireFirebaseAuth, async (req, res) => {
  const roomName = String(req.body.roomName || "").trim();
  if (!roomName) {
    return res.status(400).json({ error: "roomName is required." });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return res
      .status(500)
      .json({ error: "LiveKit credentials are not configured on the server." });
  }

  let room;
  if (mongoose.isValidObjectId(roomName)) {
    room = await mongoData.findOne({
      _id: roomName,
      ...conversationVisibilityFor(req.authUser.uid),
    });
    if (!room)
      room = await Group.findOne({
        _id: roomName,
        "members.uid": req.authUser.uid,
      });
  }
  if (!room || !canAccessConversation(room, req.authUser.uid)) {
    return res
      .status(403)
      .json({ error: "You do not have access to this call room." });
  }

  const profile = await getFirebaseUser(req.authUser.uid);
  const at = new AccessToken(apiKey, apiSecret, {
    identity: req.authUser.uid,
    name: profile.displayName,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  try {
    const token = await at.toJwt();
    res.status(200).json({ token });
  } catch (error) {
    console.error("Failed to generate token:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

//listen//
app.listen(port, () => console.log(`Server is running on port ${port}`));

// HANDSHAKE ROUTE: Propose or accept a timer
app.post("/api/channels/:id/timer", requireFirebaseAuth, async (req, res) => {
  const durationInSeconds = Number(req.body.durationInSeconds);
  const channelId = req.params.id;

  try {
    if (!mongoose.isValidObjectId(channelId)) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    if (
      !Number.isInteger(durationInSeconds) ||
      durationInSeconds < 0 ||
      durationInSeconds > 86400
    ) {
      return res.status(400).json({
        error: "Timer must be a whole number between 0 and 86400 seconds.",
      });
    }
    const channel = await mongoData.findOne({
      _id: channelId,
      ...conversationVisibilityFor(req.authUser.uid),
    });
    if (!channel) return res.status(404).send("Channel not found");
    if (!canAccessConversation(channel, req.authUser.uid)) {
      return res
        .status(403)
        .json({ error: "You do not have access to this conversation." });
    }

    const participantUids =
      channel.type === "dm"
        ? channel.participantIds || []
        : Array.from(
            new Set(
              [channel.ownerUid, ...(channel.memberUids || [])].filter(Boolean),
            ),
          );
    const uid = req.authUser.uid;
    const agreedByUids = channel.ephemeralSettings?.agreedByUids || [];

    if (durationInSeconds === 0) {
      // Turn off
      channel.ephemeralSettings = {
        active: false,
        durationInSeconds: 0,
        agreedByUids: [],
      };
    } else if (
      channel.ephemeralSettings.durationInSeconds !== durationInSeconds
    ) {
      // Propose new time
      channel.ephemeralSettings = {
        durationInSeconds,
        agreedByUids: [uid],
        active: false,
      };
    } else {
      // Accept existing proposal
      if (!channel.ephemeralSettings.agreedByUids.includes(uid)) {
        channel.ephemeralSettings.agreedByUids = [
          ...new Set([...agreedByUids, uid]),
        ];
      }
      if (
        channel.ephemeralSettings.agreedByUids.length >= participantUids.length
      ) {
        channel.ephemeralSettings.active = true;
      }
    }

    await channel.save();
    res.status(200).send(channel.ephemeralSettings);
  } catch (err) {
    res.status(500).send(err);
  }
});

// MESSAGE POST ROUTE: Attach expireAt if timer is active
app.post("/api/messages/new", requireFirebaseAuth, async (req, res) => {
  const channelId = String(req.query.id || "");
  try {
    if (!mongoose.isValidObjectId(channelId)) {
      return res.status(404).json({ error: "Channel not found." });
    }
    const channel = await mongoData.findOne({
      _id: channelId,
      ...channelVisibilityFor(req.authUser.uid),
    });
    if (!channel) return res.status(404).json({ error: "Channel not found." });

    const text =
      typeof req.body.message === "string" ? req.body.message.trim() : "";
    const voiceData =
      typeof req.body.voiceData === "string" ? req.body.voiceData : "";
    const attachment =
      req.body.attachment && typeof req.body.attachment === "object"
        ? req.body.attachment
        : null;
    if (!text && !voiceData && !attachment) {
      return res
        .status(400)
        .json({ error: "A message, voice note, or file is required." });
    }

    const sender = {
      uid: req.authUser.uid,
      displayName: req.authUser.name || req.authUser.email || "User",
      email: req.authUser.email || "",
      photo: req.authUser.picture || "",
    };
    const finalMessage =
      text ||
      (attachment
        ? `📎 ${attachment.name || "Shared a file"}`
        : "🎤 Voice note");
    const expireAt = channel.ephemeralSettings?.active
      ? new Date(
          Date.now() + channel.ephemeralSettings.durationInSeconds * 1000,
        )
      : undefined;
    const updatedChannel = await mongoData.findOneAndUpdate(
      { _id: channelId, ...channelVisibilityFor(req.authUser.uid) },
      {
        $push: {
          conversation: {
            message: finalMessage,
            timestamp: new Date().toISOString(),
            user: sender,
            voiceData: voiceData || undefined,
            attachment: attachment || undefined,
            expireAt,
          },
        },
      },
      { new: true },
    );
    if (!updatedChannel)
      return res.status(404).json({ error: "Channel not found." });
    res.status(201).send(updatedChannel);
  } catch (err) {
    console.error("Legacy message save failed:", err.message);
    res.status(500).json({ error: "Could not save message." });
  }
});

// BACKGROUND SWEEPER: Delete expired messages every 10 seconds
setInterval(async () => {
  try {
    await mongoData.updateMany(
      {},
      {
        $pull: {
          conversation: { expireAt: { $lt: new Date() } },
        },
      },
    );
  } catch (err) {
    console.error("Message sweeper failed:", err);
  }
}, 10000);
