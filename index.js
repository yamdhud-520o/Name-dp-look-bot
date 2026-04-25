const express = require('express');
const bodyParser = require('body-parser');
const login = require('ws3-fca');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- GLOBAL STATE ---
let botAPI = null;
let adminID = '61583697605712';
let prefix = '/';
let botNickname = 'YAMDHUD BOT PAPA';

let lockedGroups = {};
let lockedNicknames = {};
let lockedGroupPhoto = {};  // Store { imageUrl, lockedBy, timestamp }
let fightSessions = {};
let joinedGroups = new Set();
let targetSessions = {};
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;
let currentCookies = null;
let reconnectAttempt = 0;
const signature = `\n                ⚜️⚜️\n 👅`;
const separator = `\n⚜️___⚜️𝟗𝐌𝐀𝐌-𝐗-𝐘𝐀𝐌𝐃𝐇𝐔𝐃___⚜️____⚜️`;

// --- FIGHT MODE COLLECTOR ---
let fightMessageCollector = {};

// --- UTILITY FUNCTIONS ---
function emitLog(message, isError = false) {
  const logMessage = `[${new Date().toISOString()}] ${isError ? '❌ ERROR: ' : '✅ INFO: '}${message}`;
  console.log(logMessage);
  io.emit('botlog', logMessage);
}

function saveCookies() {
  if (!botAPI) {
    emitLog('❌ Cannot save cookies: Bot API not initialized.', true);
    return;
  }
  try {
    const newAppState = botAPI.getAppState();
    const configToSave = {
      botNickname: botNickname,
      cookies: newAppState
    };
    fs.writeFileSync('config.json', JSON.stringify(configToSave, null, 2));
    currentCookies = newAppState;
    emitLog('✅ AppState saved successfully.');
  } catch (e) {
    emitLog('❌ Failed to save AppState: ' + e.message, true);
  }
}

// --- BOT INITIALIZATION ---
function initializeBot(cookies, prefix, adminID) {
  emitLog('🚀 Initializing bot with ws3-fca...');
  currentCookies = cookies;
  reconnectAttempt = 0;

  login({ appState: currentCookies }, (err, api) => {
    if (err) {
      emitLog(`❌ Login error: ${err.message}. Retrying in 10 seconds.`, true);
      setTimeout(() => initializeBot(currentCookies, prefix, adminID), 10000);
      return;
    }

    emitLog('✅ Bot successfully logged in.');
    botAPI = api;
    botAPI.setOptions({
      selfListen: true,
      listenEvents: true,
      updatePresence: false
    });

    updateJoinedGroups(api);

    setTimeout(() => {
        setBotNicknamesInGroups();
        sendStartupMessage();
        startListening(api);
    }, 5000);

    setInterval(saveCookies, 600000);
  });
}

// --- START LISTENING WITH ALL HANDLERS ---
function startListening(api) {
  api.listenMqtt(async (err, event) => {
    if (err) {
      emitLog(`❌ Listener error: ${err.message}. Attempting to reconnect...`, true);
      reconnectAndListen();
      return;
    }

    try {
      if (event.type === 'message' || event.type === 'message_reply') {
        await handleMessage(api, event);
      } else if (event.logMessageType === 'log:thread-name') {
        await handleThreadNameChange(api, event);
      } else if (event.logMessageType === 'log:user-nickname') {
        await handleNicknameChange(api, event);
      } else if (event.logMessageType === 'log:thread-image') {
        await handleGroupImageChange(api, event);
      } else if (event.logMessageType === 'log:subscribe') {
        await handleBotAddedToGroup(api, event);
      }
      
      // Fight mode message handling
      if (event.type === 'message' && fightSessions[event.threadID] && fightSessions[event.threadID].waitingForName) {
        const targetName = event.body;
        if (targetName && targetName !== '/stop') {
          startFightMode(api, event.threadID, targetName);
        }
        fightSessions[event.threadID].waitingForName = false;
      }
      
    } catch (e) {
      emitLog(`❌ Handler crashed: ${e.message}. Event: ${event.type}`, true);
    }
  });
}

// --- FIGHT MODE FUNCTION ---
function startFightMode(api, threadID, targetName) {
  if (fightSessions[threadID] && fightSessions[threadID].interval) {
    clearInterval(fightSessions[threadID].interval);
  }
  
  const fightMessages = [
    `👊 ${targetName} TERI MA KI CHUT 👊`,
    `🤜 ${targetName} BHEN KE LODE 🤛`,
    `💥 ${targetName} RANDI KE BACHCHE 💥`,
    `🔥 ${targetName} CHUP CHAP MAR JA 🔥`,
    `⚡ ${targetName} TERI GAND FOD DUNGA ⚡`,
    `💢 ${targetName} MADARCHOD 💢`,
    `👎 ${targetName} TU KYA HAI 👎`,
    `🎯 ${targetName} TARGET LOCKED 🎯`
  ];
  
  let messageIndex = 0;
  const interval = setInterval(async () => {
    try {
      const msg = fightMessages[messageIndex % fightMessages.length];
      await api.sendMessage(msg, threadID);
      messageIndex++;
    } catch(e) {
      emitLog(`Fight message error: ${e.message}`, true);
    }
  }, 3000);
  
  fightSessions[threadID] = {
    active: true,
    targetName: targetName,
    interval: interval,
    waitingForName: false
  };
  
  api.sendMessage(`⚔️ FIGHT MODE ACTIVATED ⚔️\nTarget: ${targetName}\nHar 3 second mein message bhejunga!`, threadID);
}

function reconnectAndListen() {
  reconnectAttempt++;
  emitLog(`🔄 Reconnect attempt #${reconnectAttempt}...`, false);

  if (botAPI) {
    try {
      botAPI.stopListening();
    } catch (e) {
      emitLog(`❌ Failed to stop listener: ${e.message}`, true);
    }
  }

  if (reconnectAttempt > 5) {
    emitLog('❌ Maximum reconnect attempts reached. Restarting login process.', true);
    initializeBot(currentCookies, prefix, adminID);
  } else {
    setTimeout(() => {
      if (botAPI) {
        startListening(botAPI);
      } else {
        initializeBot(currentCookies, prefix, adminID);
      }
    }, 5000);
  }
}

async function setBotNicknamesInGroups() {
  if (!botAPI) return;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    const botID = botAPI.getCurrentUserID();
    for (const thread of threads) {
        try {
            const threadInfo = await botAPI.getThreadInfo(thread.threadID);
            if (threadInfo && threadInfo.nicknames && threadInfo.nicknames[botID] !== botNickname) {
                await botAPI.changeNickname(botNickname, thread.threadID, botID);
                emitLog(`✅ Bot's nickname set in group: ${thread.threadID}`);
            }
        } catch (e) {
            emitLog(`❌ Error setting nickname in group ${thread.threadID}: ${e.message}`, true);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (e) {
    emitLog(`❌ Error getting thread list for nickname check: ${e.message}`, true);
  }
}

async function sendStartupMessage() {
  if (!botAPI) return;
  const startupMessage = `𝐀𝐋𝐋 𝐇𝐀𝐓𝐄𝐑 𝐊𝐈 𝐌𝐀𝐀 𝐂𝐇𝐎𝐃 𝐃𝐄𝐍𝐀 𝐁𝐀𝐋𝐀 𝐁𝐎𝐓`;
  try {
    const threads = await botAPI.getThreadList(100, null, ['GROUP']);
    for (const thread of threads) {
        botAPI.sendMessage(startupMessage, thread.threadID)
          .catch(e => emitLog(`❌ Error sending startup message to ${thread.threadID}: ${e.message}`, true));
        await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (e) {
    emitLog(`❌ Error getting thread list for startup message: ${e.message}`, true);
  }
}

async function updateJoinedGroups(api) {
  try {
    const threads = await api.getThreadList(100, null, ['GROUP']);
    joinedGroups = new Set(threads.map(t => t.threadID));
    emitGroups();
    emitLog('✅ Joined groups list updated successfully.');
  } catch (e) {
    emitLog('❌ Failed to update joined groups: ' + e.message, true);
  }
}

// --- WEB SERVER ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.post('/configure', (req, res) => {
  try {
    const cookies = JSON.parse(req.body.cookies);
    prefix = req.body.prefix || '/';
    adminID = req.body.adminID;

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).send('Error: Invalid cookies format.');
    }
    if (!adminID) {
      return res.status(400).send('Error: Admin ID is required.');
    }

    res.send('Bot configured successfully! Starting...');
    initializeBot(cookies, prefix, adminID);
  } catch (e) {
    res.status(400).send('Error: Invalid configuration.');
    emitLog('Configuration error: ' + e.message, true);
  }
});

let loadedConfig = null;
try {
  if (fs.existsSync('config.json')) {
    loadedConfig = JSON.parse(fs.readFileSync('config.json'));
    if (loadedConfig.botNickname) {
      botNickname = loadedConfig.botNickname;
      emitLog('✅ Loaded bot nickname from config.json.');
    }
    if (loadedConfig.cookies && loadedConfig.cookies.length > 0) {
        emitLog('✅ Cookies found. Initializing bot automatically...');
        initializeBot(loadedConfig.cookies, prefix, adminID);
    } else {
        emitLog('❌ No cookies found. Please configure via dashboard.');
    }
  } else {
    emitLog('❌ No config.json found. Configure via dashboard.');
  }
} catch (e) {
  emitLog('❌ Error loading config file: ' + e.message, true);
}

const PORT = process.env.PORT || 20018;
server.listen(PORT, () => {
  emitLog(`✅ Server running on port ${PORT}`);
});

io.on('connection', (socket) => {
  emitLog('✅ Dashboard client connected');
  socket.emit('botlog', `Bot status: ${botAPI ? 'Started' : 'Not started'}`);
  socket.emit('groupsUpdate', Array.from(joinedGroups));
});

async function handleBotAddedToGroup(api, event) {
  const { threadID, logMessageData } = event;
  const botID = api.getCurrentUserID();

  if (logMessageData.addedParticipants.some(p => p.userFbId === botID)) {
    try {
      await api.changeNickname(botNickname, threadID, botID);
      await api.sendMessage(`𝐇𝐀𝐓𝐄𝐑 𝐁𝐇𝐄𝐀𝐍 𝐊𝐎 𝐆𝐇𝐎𝐃𝐈 𝐁𝐀𝐍𝐀 𝐁𝐀𝐋𝐀 𝐂𝐇𝐎𝐃𝐔 𝐂𝐈𝐃 𝐁𝐎𝐓`, threadID);
      emitLog(`✅ Bot added to new group: ${threadID}`);
    } catch (e) {
      emitLog('❌ Error handling bot addition: ' + e.message, true);
    }
  }
}

function emitGroups() {
    io.emit('groupsUpdate', Array.from(joinedGroups));
}

async function formatMessage(api, event, mainMessage) {
    const { senderID } = event;
    let senderName = 'User';
    try {
      const userInfo = await api.getUserInfo(senderID);
      senderName = userInfo && userInfo[senderID] && userInfo[senderID].name ? userInfo[senderID].name : 'User';
    } catch (e) {
      emitLog('❌ Error fetching user info: ' + e.message, true);
    }
    
    const styledMentionBody = `             [⚜️3> ${senderName}<3⚜️]`;
    const fromIndex = styledMentionBody.indexOf(senderName);
    
    const mentionObject = {
        tag: senderName,
        id: senderID,
        fromIndex: fromIndex
    };

    const finalMessage = `${styledMentionBody}\n${mainMessage}${signature}${separator}`;

    return {
        body: finalMessage,
        mentions: [mentionObject]
    };
}

// ==================== MAIN MESSAGE HANDLER ====================
async function handleMessage(api, event) {
  try {
    const { threadID, senderID, body, mentions } = event;
    const isAdmin = senderID === adminID;
    
    let replyMessage = '';
    let isReply = false;

    // Admin mention reply
    if (Object.keys(mentions || {}).includes(adminID)) {
      const abuses = [
        "Oye mere boss ko gali dega to teri bah.. chod dunga!",
        "𝘛𝘈𝘙𝘐 𝘓𝘈𝘋𝘒𝘐𝘐𝘐 𝘒𝘐 𝘒𝘈𝘓𝘐 𝘊𝘏𝘜𝘛 𝘔𝘈𝘙 𝘒𝘌 𝘉𝘏𝘎𝘎 𝘒𝘈𝘜𝘎𝘈",
        "ᴛᴀʀɪ ᴍᴀᴀ ᴋᴏ ᴄʜᴏᴅᴜ ʙᴀᴛᴀ ᴛᴀʀᴇ ꜱᴀᴍɴᴇ",
        "𝚃𝙰𝚁𝙴 𝙳𝙰𝙳𝙰 𝙺𝙸 𝙳𝙷𝙴𝙴 𝙺𝙸 𝙲𝙷𝚄𝚃 𝚃𝙰𝚁𝙴 𝙱𝙰𝙰𝙿 𝙺𝙰 𝙽𝙾𝙺𝙰𝚁 𝚃𝙷𝙾𝚁𝙸 𝙷𝚄"
      ];
      const randomAbuse = abuses[Math.floor(Math.random() * abuses.length)];
      const formattedAbuse = await formatMessage(api, event, randomAbuse);
      return await api.sendMessage(formattedAbuse, threadID);
    }

    // Auto replies
    if (body) {
      const lowerCaseBody = body.toLowerCase();
      
      if (lowerCaseBody.includes('mkc')) {
        replyMessage = `👅𝐓𝐔𝐌 𝐀𝐊 𝐁𝐇𝐄𝐀𝐍 𝐊𝐈 𝐋𝐎𝐃𝐈𝐈 𝐇𝐀𝐈 𝐇𝐎👅`;
        isReply = true;
      } else if (lowerCaseBody.includes('randi')) {
        replyMessage = `😑𝐊𝐘𝐀 𝐑𝐄 𝐁𝐇𝐄𝐀𝐍 𝐊𝐄 𝐂𝐇𝐔𝐃𝐀𝐘𝐄 𝐓𝐌𝐊𝐂😶`;
        isReply = true;
      } else if (lowerCaseBody.includes('teri maa chod dunga')) {
        replyMessage = `🍢𝐎𝐑 𝐌𝐄 𝐓𝐀𝐑𝐈 𝐌𝐀𝐀 𝐎𝐔𝐑 𝐁𝐇𝐄𝐍 𝐊𝐎 𝐂𝐇𝐎𝐃 𝐊𝐄 𝐉𝐀𝐀𝐋 𝐉𝐀𝐔𝐆𝐀 𝐆𝐀𝐍𝐃𝐔✊`;
        isReply = true;
      } else if (lowerCaseBody.includes('chutiya')) {
        replyMessage = `😭𝗧𝗨 𝗖𝗛𝗨𝗧𝗜𝗬𝗔 𝗧𝗘𝗥𝗔 𝗕𝗔𝗔𝗣 𝗖𝗛𝗨𝗧𝗜𝗬𝗔 𝗧𝗘𝗥𝗔 𝗣𝗨𝗥𝗔 𝗞𝗛𝗔𝗡𝗗𝗔𝗡 𝗖𝗛𝗨𝗧𝗜𝗬𝗔 𝗡𝗜𝗞𝗔𝗟 𝗠𝗔𝗗𝗔𝗥𝗫𝗖𝗛𝗢𝗗😭`;
        isReply = true;
      } else if (lowerCaseBody.trim() === 'bot') {
        const botResponses = [
            `👅𝐇𝐎𝐒𝐀 𝐌𝐄 𝐀𝐎𝐎 𝐀𝐁𝐈𝐉𝐄𝐓 𝐉𝐇𝐀𝐓𝐔 𝐑𝐀𝐍𝐃𝐈 𝐊𝐄 `,
            `𝐀𝐆𝐑 𝐀𝐕 𝐒𝐄 𝐁𝐎𝐓 𝐁𝐎𝐋𝐀 𝐓𝐎 𝐓𝐀𝐑𝐈 𝐌𝐀𝐀 𝐊𝐈 𝐂𝐇𝐔𝐓 𝐌𝐄 𝐌𝐀𝐆𝐈 𝐁𝐀𝐍𝐀 𝐃𝐔𝐆𝐀 ✊`,
            `🤡𝐀𝐁 𝐓𝐔 𝐏𝐈𝐑 𝐁𝐎𝐋𝐄𝐆𝐀 𝐁𝐎𝐓 𝐌𝐄 𝐂𝐇𝐎𝐃𝐔𝐆𝐀 𝐓𝐇𝐔𝐉𝐇𝐀 𝐒𝐀𝐋𝐎 𝐒𝐇𝐎𝐓`,
            `✊𝐄𝐃𝐇𝐀𝐑 𝐆𝐀𝐋𝐈 𝐄𝐃𝐇𝐀𝐑 𝐆𝐀𝐋𝐈 𝐁𝐇𝐈𝐂𝐇 𝐌𝐄 𝐏𝐀𝐃𝐀 𝐎𝐓 𝐓𝐀𝐑𝐈 𝐌𝐀𝐀 𝐂𝐇𝐎𝐃𝐍𝐀 𝐁𝐀𝐋𝐀 𝐇𝐔 𝐌𝐄 𝐁𝐎𝐓😎`
        ];
        replyMessage = botResponses[Math.floor(Math.random() * botResponses.length)];
        isReply = true;
      }
      
      if (isReply) {
          const formattedReply = await formatMessage(api, event, replyMessage);
          return await api.sendMessage(formattedReply, threadID);
      }
    }

    // Command handling
    if (!body || !body.startsWith(prefix)) return;
    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    let commandReply = '';

    switch (command) {
      case 'group':
        await handleGroupCommand(api, event, args, isAdmin);
        return;
      case 'nickname':
        await handleNicknameCommand(api, event, args, isAdmin);
        return;
      case 'botnick':
        await handleBotNickCommand(api, event, args, isAdmin);
        return;
      case 'tid':
        commandReply = `Group ID: ${threadID}`;
        break;
      
      case 'uid':
        if (Object.keys(mentions || {}).length > 0) {
          const mentionedID = Object.keys(mentions)[0];
          try {
            const userInfo = await api.getUserInfo(mentionedID);
            const user = userInfo[mentionedID];
            commandReply = `👤 Name: ${user.name}\n🆔 ID: ${mentionedID}\n🔗 fb.com/${mentionedID}`;
          } catch(e) {
            commandReply = `❌ Error: ${e.message}`;
          }
        } else {
          commandReply = `👤 Your ID: ${senderID}`;
        }
        break;
      
      // FIGHT COMMAND - WORKING
      case 'fyt':
      case 'fiyt':
      case 'fight':
        if (!isAdmin) {
          commandReply = "❌ Sirf admin fight mode use kar sakta hai!";
          break;
        }
        const fightArg = args.shift();
        if (fightArg === 'on') {
          fightSessions[threadID] = { waitingForName: true };
          commandReply = "🔥 FIGHT MODE ON! 🔥\nAb target ka naam likho:";
        } else if (fightArg === 'off') {
          if (fightSessions[threadID] && fightSessions[threadID].interval) {
            clearInterval(fightSessions[threadID].interval);
          }
          delete fightSessions[threadID];
          commandReply = "🛑 FIGHT MODE OFF! 🛑";
        } else {
          commandReply = `✅ Usage: ${prefix}fyt on | ${prefix}fyt off`;
        }
        break;
        
      case 'stop':
        if (fightSessions[threadID] && fightSessions[threadID].interval) {
          clearInterval(fightSessions[threadID].interval);
          delete fightSessions[threadID];
          commandReply = "🛑 Fight mode stopped!";
        } else if (targetSessions[threadID] && targetSessions[threadID].interval) {
          clearInterval(targetSessions[threadID].interval);
          delete targetSessions[threadID];
          commandReply = "🛑 Target mode stopped!";
        } else {
          commandReply = "❌ Koi fight/target mode active nahi hai!";
        }
        break;
        
      case 'target':
        await handleTargetCommand(api, event, args, isAdmin);
        return;
        
      case 'help':
        await handleHelpCommand(api, event);
        return;
      
      // ========== PHOTO LOCK - FIXED ==========
      case 'photolock':
        await handlePhotoLockCommand(api, event, args, isAdmin);
        return;
      
      // ========== NICKNAME LOCK - FIXED ==========
      case 'nicklock':
        await handleNickLockCommand(api, event, args, isAdmin);
        return;
        
      case 'nickremoveall':
        await handleNickRemoveAll(api, event, isAdmin);
        return;
        
      case 'nickremoveoff':
        await handleNickRemoveOff(api, event, isAdmin);
        return;
        
      case 'gclock':
        await handleGCLock(api, event, args, isAdmin);
        return;
        
      case 'gcremove':
        await handleGCRemove(api, event, isAdmin);
        return;
        
      case 'status':
        await handleStatusCommand(api, event, isAdmin);
        return;

      default:
        if (!isAdmin) {
          commandReply = `Teri ma ki ch.. tere baap ka nokar nahi hu randi ke!`;
        } else {
          commandReply = `✅ Prefix: ${prefix}\nCommands: ${prefix}help for list`;
        }
    }
    
    if (commandReply) {
        const formattedReply = await formatMessage(api, event, commandReply);
        await api.sendMessage(formattedReply, threadID);
    }

  } catch (err) {
    emitLog('❌ Error in handleMessage: ' + err.message, true);
  }
}

// ==================== GROUP NAME HANDLER ====================
async function handleGroupCommand(api, event, args, isAdmin) {
  try {
    const { threadID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "❌ Sirf admin group lock kar sakta hai!");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const groupName = args.join(' ');
      if (!groupName) {
        const reply = await formatMessage(api, event, `✅ Usage: ${prefix}group on <name>`);
        return await api.sendMessage(reply, threadID);
      }
      lockedGroups[threadID] = groupName;
      await api.setTitle(groupName, threadID);
      const reply = await formatMessage(api, event, `🔒 Group name locked: "${groupName}"`);
      await api.sendMessage(reply, threadID);
    } else if (subCommand === 'off') {
        delete lockedGroups[threadID];
        const reply = await formatMessage(api, event, "🔓 Group name unlocked!");
        await api.sendMessage(reply, threadID);
    } else {
        const reply = await formatMessage(api, event, `Usage: ${prefix}group on <name> | ${prefix}group off`);
        await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handleGroupCommand: ' + error.message, true);
  }
}

// ==================== NICKNAME CHANGE EVENT - FIXED ====================
async function handleNicknameChange(api, event) {
  try {
    const { threadID, authorID, participantID, newNickname } = event;
    const botID = api.getCurrentUserID();

    // Bot ka nickname protect karo
    if (participantID === botID && authorID !== adminID) {
      if (newNickname !== botNickname) {
        await api.changeNickname(botNickname, threadID, botID);
        await api.sendMessage(`😈 MERA NICKNAME "${botNickname}" WAPAS KAR DIYA! 😈`, threadID);
        emitLog(`Bot nickname restored in ${threadID}`);
      }
    }
    
    // Group nickname lock - AUTO RESTORE
    if (lockedNicknames[threadID] && authorID !== adminID) {
      const lockedNick = lockedNicknames[threadID];
      
      if (newNickname !== lockedNick) {
        await api.changeNickname(lockedNick, threadID, participantID);
        
        const userInfo = await api.getUserInfo(authorID);
        const authorName = userInfo[authorID]?.name || "Kisi ne";
        
        await api.sendMessage({
          body: `🔒 @${authorName} NICKNAME LOCKED HAI! Wapas "${lockedNick}" kar diya.`,
          mentions: [{ tag: authorName, id: authorID, fromIndex: 2 }]
        }, threadID);
        
        emitLog(`Nickname restored for user ${participantID} in ${threadID}`);
      }
    }
    
    // Nick remove all mode
    if (nickRemoveEnabled && authorID !== adminID && participantID !== botID) {
      await api.changeNickname("", threadID, participantID);
    }
    
  } catch (error) {
    emitLog('❌ Error in handleNicknameChange: ' + error.message, true);
  }
}

// ==================== NICKNAME LOCK COMMAND - FIXED ====================
async function handleNickLockCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "❌ Sirf admin nickname lock kar sakta hai!");
    return api.sendMessage(reply, threadID);
  }

  const subCommand = args.shift()?.toLowerCase();
  
  if (subCommand === 'on') {
    const newNick = args.join(' ').trim();
    
    if (!newNick) {
      const reply = await formatMessage(api, event, `✅ Usage: ${prefix}nicklock on <nickname>`);
      return api.sendMessage(reply, threadID);
    }
    
    // Sab members ka nickname change karo
    const threadInfo = await api.getThreadInfo(threadID);
    let changedCount = 0;
    
    for (const user of threadInfo.participantIDs) {
      if (user !== adminID && user !== api.getCurrentUserID()) {
        try {
          await api.changeNickname(newNick, threadID, user);
          changedCount++;
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch(e) {
          emitLog(`Failed to change nickname for ${user}: ${e.message}`, true);
        }
      }
    }
    
    // Store lock info
    lockedNicknames[threadID] = newNick;
    nickRemoveEnabled = false;
    
    const reply = await formatMessage(api, event, `✅ NICKNAME LOCK ON!\nSabka nickname "${newNick}" kar diya.\n${changedCount} members affected.`);
    await api.sendMessage(reply, threadID);
    
  } else if (subCommand === 'off') {
    delete lockedNicknames[threadID];
    const reply = await formatMessage(api, event, `🔓 NICKNAME LOCK OFF! Ab koi bhi nickname change kar sakta hai.`);
    await api.sendMessage(reply, threadID);
    
  } else {
    const reply = await formatMessage(api, event, `Usage: ${prefix}nicklock on <nickname> | ${prefix}nicklock off`);
    await api.sendMessage(reply, threadID);
  }
}

// ==================== PHOTO LOCK - FIXED ====================
async function handlePhotoLockCommand(api, event, args, isAdmin) {
  try {
    const { threadID } = event;
    
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "❌ Sirf admin photo lock kar sakta hai!");
      return await api.sendMessage(reply, threadID);
    }
    
    const subCommand = args.shift();
    
    if (subCommand === 'on') {
      const threadInfo = await api.getThreadInfo(threadID);
      
      if (threadInfo.imageSrc) {
        lockedGroupPhoto[threadID] = {
          imageSrc: threadInfo.imageSrc,
          lockedBy: adminID,
          timestamp: Date.now()
        };
        const reply = await formatMessage(api, event, "📸 GROUP PHOTO LOCKED! Ab koi change nahi kar sakta.");
        await api.sendMessage(reply, threadID);
      } else {
        const reply = await formatMessage(api, event, "❌ Pehle group mein photo set karo, phir /photolock on karo.");
        await api.sendMessage(reply, threadID);
      }
      
    } else if (subCommand === 'off') {
      delete lockedGroupPhoto[threadID];
      const reply = await formatMessage(api, event, "📸 GROUP PHOTO UNLOCKED! Ab koi bhi change kar sakta hai.");
      await api.sendMessage(reply, threadID);
      
    } else {
      const reply = await formatMessage(api, event, `Usage: ${prefix}photolock on | ${prefix}photolock off`);
      await api.sendMessage(reply, threadID);
    }
    
  } catch (error) {
    emitLog('❌ Error in handlePhotoLockCommand: ' + error.message, true);
  }
}

// ==================== GROUP IMAGE CHANGE EVENT - FIXED ====================
async function handleGroupImageChange(api, event) {
  try {
    const { threadID, authorID } = event;
    
    // Agar photo lock on hai aur admin ne change nahi kiya to RESTORE
    if (lockedGroupPhoto[threadID] && authorID !== adminID) {
      const lockedPhoto = lockedGroupPhoto[threadID];
      
      if (lockedPhoto.imageSrc) {
        // Wapas purani photo set karo
        await api.changeGroupImage(lockedPhoto.imageSrc, threadID);
        
        const userInfo = await api.getUserInfo(authorID);
        const authorName = userInfo[authorID]?.name || "Kisi ne";
        
        await api.sendMessage({
          body: `🔒 @${authorName} GROUP PHOTO LOCKED HAI! Wapas purani photo kar di.`,
          mentions: [{ tag: authorName, id: authorID, fromIndex: 2 }]
        }, threadID);
        
        emitLog(`Group photo restored in ${threadID} - changed by ${authorID}`);
      }
    }
    
  } catch (error) {
    emitLog('❌ Error in handleGroupImageChange: ' + error.message, true);
  }
}

// ==================== THREAD NAME CHANGE ====================
async function handleThreadNameChange(api, event) {
  try {
    const { threadID, authorID } = event;
    const newTitle = event.logMessageData?.name;
    
    if (lockedGroups[threadID] && authorID !== adminID) {
      if (newTitle !== lockedGroups[threadID]) {
        await api.setTitle(lockedGroups[threadID], threadID);
        await api.sendMessage(`🔒 Group name locked! Wapas "${lockedGroups[threadID]}" kar diya.`, threadID);
        emitLog(`Group name restored in ${threadID}`);
      }
    }
  } catch (error) {
    emitLog('❌ Error in handleThreadNameChange: ' + error.message, true);
  }
}

// ==================== OTHER COMMANDS ====================
async function handleNicknameCommand(api, event, args, isAdmin) {
  try {
    const { threadID } = event;
    if (!isAdmin) {
      const reply = await formatMessage(api, event, "❌ Sirf admin kar sakta hai!");
      return await api.sendMessage(reply, threadID);
    }
    const subCommand = args.shift();
    if (subCommand === 'on') {
      const nickname = args.join(' ');
      if (!nickname) {
        const reply = await formatMessage(api, event, `Usage: ${prefix}nickname on <nickname>`);
        return await api.sendMessage(reply, threadID);
      }
      const threadInfo = await api.getThreadInfo(threadID);
      for (const pid of threadInfo.participantIDs) {
        if (pid !== adminID && pid !== api.getCurrentUserID()) {
          await api.changeNickname(nickname, threadID, pid);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      const reply = await formatMessage(api, event, `✅ Sabka nickname "${nickname}" kar diya!`);
      await api.sendMessage(reply, threadID);
    }
  } catch (error) {
    emitLog('❌ Error in handleNicknameCommand: ' + error.message, true);
  }
}

async function handleBotNickCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "❌ Sirf admin bot nickname change kar sakta hai!");
    return api.sendMessage(reply, threadID);
  }
  const newNickname = args.join(' ');
  if (!newNickname) {
    const reply = await formatMessage(api, event, `Usage: ${prefix}botnick <nickname>`);
    return api.sendMessage(reply, threadID);
  }
  botNickname = newNickname;
  const botID = api.getCurrentUserID();
  try {
    fs.writeFileSync('config.json', JSON.stringify({ botNickname: newNickname, cookies: currentCookies }, null, 2));
    await api.changeNickname(newNickname, threadID, botID);
    const reply = await formatMessage(api, event, `✅ Bot nickname changed to: ${newNickname}`);
    await api.sendMessage(reply, threadID);
  } catch (e) {
    emitLog('❌ Error setting bot nickname: ' + e.message, true);
  }
}

async function handleTargetCommand(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) {
    const reply = await formatMessage(api, event, "❌ Sirf admin target mode use kar sakta hai!");
    return await api.sendMessage(reply, threadID);
  }

  const subCommand = args.shift()?.toLowerCase();
  
  if (subCommand === 'on') {
    const fileNumber = args.shift();
    const targetName = args.join(' ');

    if (!fileNumber || !targetName) {
      const reply = await formatMessage(api, event, `Usage: ${prefix}target on <file_number> <name>`);
      return await api.sendMessage(reply, threadID);
    }

    const filePath = path.join(__dirname, `np${fileNumber}.txt`);
    if (!fs.existsSync(filePath)) {
      const reply = await formatMessage(api, event, `❌ File "np${fileNumber}.txt" nahi mila.`);
      return await api.sendMessage(reply, threadID);
    }

    const targetMessages = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '');

    if (targetMessages.length === 0) {
      const reply = await formatMessage(api, event, `❌ File "np${fileNumber}.txt" khali hai.`);
      return await api.sendMessage(reply, threadID);
    }

    if (targetSessions[threadID] && targetSessions[threadID].interval) {
      clearInterval(targetSessions[threadID].interval);
    }

    let currentIndex = 0;
    const interval = setInterval(async () => {
      const message = `${targetName} ${targetMessages[currentIndex]}`;
      try {
        await botAPI.sendMessage(message, threadID);
        currentIndex = (currentIndex + 1) % targetMessages.length;
      } catch (err) {
        emitLog('❌ Target message error: ' + err.message, true);
        clearInterval(interval);
        delete targetSessions[threadID];
      }
    }, 10000);

    targetSessions[threadID] = {
      active: true,
      targetName,
      interval
    };
    
    const reply = await formatMessage(api, event, `🎯 TARGET LOCKED! ${targetName} pe 10 sec mein attack start.`);
    await api.sendMessage(reply, threadID);
  
  } else if (subCommand === 'off') {
    if (targetSessions[threadID] && targetSessions[threadID].interval) {
      clearInterval(targetSessions[threadID].interval);
      delete targetSessions[threadID];
      const reply = await formatMessage(api, event, "🛑 Target mode off!");
      await api.sendMessage(reply, threadID);
    } else {
      const reply = await formatMessage(api, event, "❌ Target mode active nahi hai!");
      await api.sendMessage(reply, threadID);
    }
  }
}

async function handleGCLock(api, event, args, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  const newName = args.join(' ').trim();
  if (!newName) return;
  lockedGroups[threadID] = newName;
  await api.setTitle(newName, threadID);
  await api.sendMessage(`🔒 Group name locked: "${newName}"`, threadID);
}

async function handleGCRemove(api, event, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  delete lockedGroups[threadID];
  await api.sendMessage(`🔓 Group name unlocked`, threadID);
}

async function handleNickRemoveAll(api, event, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  nickRemoveEnabled = true;
  delete lockedNicknames[threadID];
  const threadInfo = await api.getThreadInfo(threadID);
  for (const user of threadInfo.userInfo) {
    if (String(user.id) !== adminID && String(user.id) !== api.getCurrentUserID()) {
      await api.changeNickname("", threadID, String(user.id));
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  await api.sendMessage(`💥 All nicknames cleared! Auto-remove ON`, threadID);
}

async function handleNickRemoveOff(api, event, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  nickRemoveEnabled = false;
  await api.sendMessage(`🛑 Nick auto-remove OFF`, threadID);
}

async function handleStatusCommand(api, event, isAdmin) {
  const { threadID } = event;
  if (!isAdmin) return;
  
  const msg = `
📊 BOT STATUS:
• Group Lock: ${lockedGroups[threadID] ? "ON ✅" : "OFF ❌"}
• Nick Lock: ${lockedNicknames[threadID] ? `ON ✅ (${lockedNicknames[threadID]})` : "OFF ❌"}
• Photo Lock: ${lockedGroupPhoto[threadID] ? "ON ✅" : "OFF ❌"}
• Fight Mode: ${fightSessions[threadID]?.active ? "ON ✅" : "OFF ❌"}
• Target Mode: ${targetSessions[threadID]?.active ? "ON ✅" : "OFF ❌"}
• Nick Auto-Remove: ${nickRemoveEnabled ? "ON ✅" : "OFF ❌"}
`;
  await api.sendMessage(msg, threadID);
}

async function handleHelpCommand(api, event) {
  const helpMessage = `
⚜️ 𝐘𝐀𝐌𝐃𝐇𝐔𝐃 𝐁𝐎𝐓 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒 ⚜️
---
🔐 GROUP COMMANDS:
  ${prefix}group on <name> - Lock group name
  ${prefix}group off - Unlock group name
  ${prefix}photolock on - Lock group photo
  ${prefix}photolock off - Unlock group photo

👤 NICKNAME COMMANDS:
  ${prefix}nicklock on <nick> - Lock all nicknames
  ${prefix}nicklock off - Unlock nicknames
  ${prefix}nickremoveall - Clear all nicknames
  ${prefix}nickremoveoff - Stop auto-remove
  ${prefix}botnick <name> - Change bot nickname

⚔️ FIGHT/TARGET:
  ${prefix}fyt on - Start fight mode
  ${prefix}fyt off - Stop fight mode
  ${prefix}target on <file> <name> - Start target attack
  ${prefix}target off - Stop target attack
  ${prefix}stop - Stop all active modes

🆔 INFO:
  ${prefix}tid - Get group ID
  ${prefix}uid - Get your ID
  ${prefix}uid @user - Get user ID
  ${prefix}status - Check all locks
  ${prefix}help - Show this menu
`;
  const formattedHelp = await formatMessage(api, event, helpMessage);
  await api.sendMessage(formattedHelp, event.threadID);
}
