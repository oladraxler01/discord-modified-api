import mogoose from "mongoose";

const discordSchema = mogoose.Schema({
    channelName: String,
    conversation: [
        {
            message: String,
            timestamp: String,
            user: {
                displayName: String,
                email: String,
                photo: String,
                uid: String
            }
        }
    ]

});



export default mogoose.model('conversations', discordSchema);
