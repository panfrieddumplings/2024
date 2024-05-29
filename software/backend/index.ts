import express from "express";
import http from "http";
import { Server } from "socket.io";
import { SiggyListener } from "./siggy_listener";
import { Game, GameClient } from "./game";

const NUM_PLAYERS = 2;
const WS_PORT = 3000;
const SIGGY_PORT = 3001;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  connectionStateRecovery: {
    // the backup duration of the sessions and the packets
    maxDisconnectionDuration: 2 * 60 * 1000,
    // whether to skip middlewares upon successful recovery
    skipMiddlewares: true,
  },
  cors: {
    origin: "http://localhost:5173",
  },
});

const siggyListener = new SiggyListener(NUM_PLAYERS, SIGGY_PORT);
const game = new Game(NUM_PLAYERS, siggyListener);

io.on("connection", (socket) => {
  console.log("websocket connected", socket.id);
  const client = new GameClient(socket);
  const joined = game.addPlayer(client);

  if (!joined) {
    console.log("game full, disconnecting client");
    // socket.emit("") maybe notify the client that the game is full?
    socket.disconnect(true);
  }
});

siggyListener.bind();
server.listen(WS_PORT, () => {
  console.log(`websocket server listening on *:${WS_PORT}`);
});
