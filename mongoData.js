import mongoose from "mongoose";

const participantSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true },
    displayName: String,
    email: String,
    photo: String,
  },
  { _id: false },
);

const discordSchema = new mongoose.Schema(
  {
    channelName: String,
    type: { type: String, enum: ["channel", "dm"], default: "channel" },
    accessMode: { type: String, enum: ["public", "invite"], default: "public" },
    ownerUid: String,
    owner: {
      uid: String,
      displayName: String,
      email: String,
      photo: String,
    },
    memberUids: { type: [String], default: [] },
    dmKey: { type: String, unique: true, sparse: true },
    participants: { type: [participantSchema], default: [] },
    participantIds: { type: [String], default: [] },
    conversation: [
      {
        message: String,
        timestamp: String,
        voiceData: String,
        user: {
          displayName: String,
          email: String,
          photo: String,
          uid: String,
        },
      },
    ],
  },
  { timestamps: true },
);

export default mongoose.model("conversations", discordSchema);
