import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import mongoData from "./mongoData.js";
import Pusher from "pusher";

//app config//
const app = express();
const port = process.env.PORT || 8002;

const pusher = new Pusher({
  appId: "2182745",
  key: "e97d599fd9d4473f90d2",
  secret: "0b078f40fcd10cd49953",
  cluster: "us2",
  useTLS: true,
});

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

const generateInviteCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

//middleware config//
app.use(
  express.json({
    limit: "10mb",
    strict: true,
    type: ["application/json", "application/*+json"],
  }),
);
app.use(cors());

//DB config//
const mongoURI =
  "mongodb+srv://olaadmin:JkVru4dy8sDwGhlL@cluster0.oq2ihlh.mongodb.net/discord?appName=Cluster0";

let changeStream;

const startConversationWatch = async () => {
  if (mongoose.connection.readyState !== 1 || changeStream) return;

  const stream = await mongoose.connection.collection("conversations").watch();
  changeStream = stream;

  stream.on("change", async (change) => {
    const event = change.operationType === "insert" ? "newChannel" :
      change.operationType === "update" ? "newMessage" : null;
    const channel = change.operationType === "insert" ? "channels" : "conversation";

    if (!event) return;

    try {
      await pusher.trigger(channel, event, { change });
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

mongoose.connect(mongoURI).catch((error) => {
  console.error("MongoDB initial connection failed:", error.message);
});

//api routes//
app.get("/", (req, res) => res.status(200).send("hello World!"));

app.post("/groups", async (req, res) => {
  try {
    const { name, creator } = req.body;

    if (!name || !creator?.uid) {
      return res.status(400).json({ error: "Group name and creator are required." });
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

app.get("/groups", async (req, res) => {
  try {
    const { uid } = req.query;

    if (!uid) {
      const groups = await Group.find().sort({ createdAt: -1 });
      return res.status(200).json(groups);
    }

    const groups = await Group.find({ "members.uid": uid }).sort({ createdAt: -1 });
    return res.status(200).json(groups);
  } catch (error) {
    console.error("Group fetch failed:", error.message);
    return res.status(500).json({ error: "Could not load groups." });
  }
});

app.post("/groups/join", async (req, res) => {
  try {
    const { inviteCode, user } = req.body;

    if (!inviteCode || !user?.uid) {
      return res.status(400).json({ error: "Invite code and user are required." });
    }

    const group = await Group.findOne({ inviteCode });

    if (!group) {
      return res.status(404).json({ error: "Invite code not found." });
    }

    const alreadyMember = group.members.some((member) => member.uid === user.uid);
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

app.post("/groups/:id/members", async (req, res) => {
  try {
    const { member } = req.body;
    if (!member?.uid && !member?.email) {
      return res.status(400).json({ error: "Member details are required." });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

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
    return res.status(503).json({ error: "Database is temporarily unavailable. Please retry shortly." });
  }
  next();
});

// Create a new channel
app.post("/new/channel", async (req, res) => {
  try {
    const dbData = req.body;
    const data = await mongoData.create(dbData);
    res.status(201).send(data);
  } catch (err) {
    console.error("Channel creation failed:", err.message);
    res.status(503).json({ error: "Could not create channel. Check the database connection and retry." });
  }
});

// Get the list of channels
app.get("/get/channelList", async (req, res) => {
  try {
    const data = await mongoData.find();
    let channels = [];

    data.map((channelData) => {
      const channelInfo = {
        id: channelData._id,
        name: channelData.channelName,
      };
      channels.push(channelInfo);
    });

    res.status(200).send(channels);
  } catch (err) {
    console.error("Channel list request failed:", err.message);
    res.status(503).json({ error: "Could not load channels. Check the database connection and retry." });
  }
});

// Add a new message to a conversation
app.post("/new/message", async (req, res) => {
  try {
    const data = await mongoData.updateOne(
      { _id: req.query.id },
      { $push: { conversation: req.body } },
    );
    res.status(201).send(data);
  } catch (err) {
    console.error("Message save failed:", err.message);
    res.status(503).json({ error: "Could not save message. Check the database connection and retry." });
  }
});

// Get all data
app.get("/get/data", async (req, res) => {
  try {
    const data = await mongoData.find();
    res.status(200).send(data);
  } catch (err) {
    console.error("Data request failed:", err.message);
    res.status(503).json({ error: "Could not load data. Check the database connection and retry." });
  }
});

// Get a specific conversation
app.get("/get/conversation", async (req, res) => {
  try {
    const data = await mongoData.find({ _id: req.query.id });
    res.status(200).send(data);
  } catch (err) {
    console.error("Conversation request failed:", err.message);
    res.status(503).json({ error: "Could not load conversation. Check the database connection and retry." });
  }
});

//listen//
app.listen(port, () => console.log(`Server is running on port ${port}`));
