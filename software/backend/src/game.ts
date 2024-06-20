import { SiggyListener, CategoricalPrediction, Action } from "./siggy_listener";
import { Server, Socket } from "socket.io";
class GameClient {
  id: string;
  playerIndex: number = -1;
  socket: Socket;
  game: Game;
  currentPrediction: Action | undefined;

  constructor(playerIndex: number, socket: Socket, game: Game) {
    this.playerIndex = playerIndex;
    this.socket = socket;
    this.id = socket.id;
    this.game = game;

    socket.on("disconnect", (reason) => {
      console.log(`client ${this.id} disconencted due to ${reason}`);
      this.onDisconnect();
    });
  }

  public onDisconnect() {
    this.game.handleDisconnect(this);
  }

  public onCategoricalPrediction(prediction: CategoricalPrediction) {
    console.log("onPredictedAction", this.id, prediction.action);
    this.currentPrediction = prediction.action;
  }

  public onDistributionalPrediction(distribution: number[]) {
    console.log("onPredictedDistribution", this.id, distribution);
  }

  public getCurrentPrediction() {
    return this.currentPrediction;
  }

  private sendXMessage() {
    this.socket.emit("<event>", {});
  }
  // ...
}

async function sleep(ms: number) {
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve(0);
    }, ms),
  );
}
class Game {
  server: Server;
  clients = new Map<string, GameClient>();
  siggyListener: SiggyListener;
  numPlayers: number;
  players: Player[] = [];
  gameState: GameState = new GameState();

  constructor(
    server: Server,
    numPlayers: number,
    siggyListener: SiggyListener,
  ) {
    this.server = server;
    this.numPlayers = numPlayers;
    this.siggyListener = siggyListener;
  }

  public getAvailablePlayers() {
    const available = Array<boolean>(this.numPlayers).fill(true);
    this.clients.forEach((client) => {
      available[client.playerIndex] = false;
    });
    const availableIndices: number[] = [];
    available.forEach((v, i) => {
      if (v) availableIndices.push(i);
    });
    return availableIndices;
  }

  public createPlayer(socket: Socket) {
    const availablePlayers = this.getAvailablePlayers();
    if (availablePlayers.length == 0) return false;

    const playerIndex = availablePlayers[0];
    const gameClient = new GameClient(playerIndex, socket, this);
    this.clients.set(socket.id, gameClient);
    this.siggyListener.attachPlayer(playerIndex, gameClient);

    // Ensure players array is properly initialized
    if (!this.players[playerIndex]) {
      this.players[playerIndex] = new Player(socket.id);
    } else {
      this.players[playerIndex].player_socket = socket.id;
    }

    const data: any[] = [];
    for (const v of this.clients.values()) {
      data.push({
        playerIndex: v.playerIndex,
        ready: this.players[playerIndex].ready,
      });
    }

    gameClient.socket
      .emitWithAck("Joined", data, this.numPlayers, playerIndex)
      .then(() => {
        this.broadcast("Player connection state update", playerIndex, true);
      });

    const remainingSlots = this.getAvailablePlayers().length;
    console.log(remainingSlots, "slots remaining");
    if (remainingSlots === 0) {
      this.startGame();
    }
    return true;
  }

  // Shuffles deck
  private shuffleDeck() {
    let deck = this.gameState.deck;
    let currentIndex = deck.length,
      randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex != 0) {
      // Pick a remaining element.
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex--;

      // And swap it with the current element.
      [deck[currentIndex], deck[randomIndex]] = [
        deck[randomIndex],
        deck[currentIndex],
      ];
    }
  }

  // Sets initial game state -- 7 cards initially in each player's hands, draw from deck option, first top card
  private setGame() {
    this.shuffleDeck();
    const starthand = 7;
    let deck = this.gameState.deck;
    for (let i = 0; i < this.numPlayers; i++) {
      /* Add draw from deck card to both player's possible hand -- OR hand */
      this.players[i].possible_hand.push(new Card("wild", 14, true));

      for (let j = 0; j < starthand; j++) {
        const drawn_card = deck.pop();
        if (drawn_card) {
          this.players[i].hand.push(drawn_card);
        }
      }
    }
    // Draws first card on playing deck
    const first_card = deck.pop();
    if (first_card) {
      this.gameState.top_card = first_card;
      this.gameState.played_cards.push(first_card);
      this.broadcast("Card Played", -1, first_card);
    }

    for (const player of this.players) {
      for (let j = 0; j < starthand; j++) {
        const drawn_card = deck.pop();
        if (drawn_card) {
          player.hand.push(drawn_card);
        }
      }

      const client = this.clients.get(player.player_socket);
      if (client) {
        player.sortPossibleHand(this.gameState.top_card!, client);
      } else {
        console.log("socket id does not correspond to player");
      }
    }
  }

  /* 
  Takes current playerIndex 
  Adds a card to the player */
  public addCard(playerIndex: number) {
    const player = this.players[playerIndex];
    let deck = this.gameState.deck;
    if (deck.length != 0) {
      const card = deck.pop();
      if (card) {
        player.hand.push(card);
      }
    }
  }

  // After playing a card, checks if special power is used and changes turn accordingly
  public readSpecial(playerIndex: number, selected: Card) {
    const number = selected.number;
    const opp = (playerIndex + 1) % 2;

    if (number == 11) {
      //add 2 cards
      this.addCard(opp);
      this.addCard(opp);
    } else if (number == 12) {
      //add 4 cards
      for (let i = 0; i < 4; i++) {
        this.addCard(opp);
      }
    }

    // Returns player index for the next round
    // Same player's turn if skip or +2 or allow player to choose wild card
    if (number) {
      if (number > 9 && number < 14) {
        return playerIndex;
      } else {
        return opp;
      }
    }
  }

  // Method to play Game -- will continue until one player has no cards
  public async playGame() {
    console.log("playing game");
    this.broadcast("Game Started");
    this.setGame();
    let currentPlayerIndex = 0;

    await sleep(2000);

    // Ensure currentPlayerIndex is valid
    if (!this.players[currentPlayerIndex]) {
      this.error(`Invalid currentPlayerIndex: ${currentPlayerIndex}`);
      return;
    }

    while (this.players[currentPlayerIndex].hand.length > 0) {
      console.log("while loop", currentPlayerIndex, this.players);

      // Calculate possible hand and send to specific client
      const current_player = this.players[currentPlayerIndex];
      const current_client = this.clients.get(current_player.player_socket);

      if (current_client) {
        current_player.sortPossibleHand(
          this.gameState.top_card!,
          current_client,
        );

        // Listening for move
        const selected = await this.players[currentPlayerIndex].moveCard(
          current_client,
          this.gameState,
        );
        console.log("selected: %o for player %d", selected, currentPlayerIndex);

        // Special functions can be performed
        currentPlayerIndex = Number(
          this.readSpecial(currentPlayerIndex, selected),
        ); // Performs special functions and changes turn if applicable

        // Ensure currentPlayerIndex is valid after update
        if (!this.players[currentPlayerIndex]) {
          this.error(
            `Invalid currentPlayerIndex after update: ${currentPlayerIndex}`,
          );
          return;
        }

        // Sends top_card to clients with playerIndex
        this.broadcast(
          "Card Played",
          currentPlayerIndex,
          this.gameState.top_card,
        );
      } else {
        this.error("socket.id does not correspond to client");
      }
      await sleep(2000);
    }

    this.endGame(currentPlayerIndex);
  }

  public async startGame() {
    console.log("started game, waiting for clenches");
    if (this.players.length === this.numPlayers) {
      this.broadcast("Ready Listen");

      // all confirm readiness with jaw clench
      let ready = false;
      while (!ready) {
        // console.log("not all ready");
        ready = true;
        for (const player of this.players) {
          const client = this.clients.get(player.player_socket);
          if (!!client) {
            const [clientReady, updated] = player.checkReady(client);
            ready = ready && clientReady;
            if (updated) {
              console.log("updated");
              this.broadcast(
                "Player ready state update",
                client.playerIndex,
                player.ready,
              );
            }
          }
        }
        await new Promise((r) => setTimeout(r, 100)); //sleep for 100 ms
      }

      this.playGame();
    }
  }

  public async endGame(winnerIndex: number) {
    this.broadcast("Game Ended", winnerIndex);
    // Timeout after 60000
    const timeoutID = setTimeout(this.closeGame, 60000);

    // P1 then P2 confirm readiness with jaw clench
    let ready = false;
    while (!ready) {
      console.log("not all ready");
      ready = true;
      for (const player of this.players) {
        const client = this.clients.get(player.player_socket);
        if (!!client) {
          const [clientReady, updated] = player.checkReady(client);
          ready = ready && clientReady;
          if (updated) {
            this.broadcast(
              "Player ready state update",
              client.playerIndex,
              player.ready,
            );
          }
        }
      }
      await new Promise((r) => setTimeout(r, 100)); //sleep for 100 ms
    }
    clearTimeout(timeoutID);

    this.broadcast("Game Started");

    this.playGame();
  }

  private closeGame() {
    this.broadcast("Game Closed");
  }

  public handleDisconnect(client: GameClient) {
    this.siggyListener.detachPlayer(client.playerIndex);
    this.clients.delete(client.id);
    const player = this.players.at(client.playerIndex);
    if (player) {
      player.ready = false;
    }
    this.broadcast("Player connection state update", client.playerIndex);
  }

  public broadcast(topic: string, ...msg: any[]) {
    // this.server.send()
    this.server.emit(topic, ...msg);
  }

  private error(message: string) {
    console.log(`Error: ${message}`);
  }
}

class GameState {
  deck: Card[] = [];
  played_cards: Card[] = [];
  top_card: Card | null = null;

  constructor() {
    //build initial game state
    const colour = ["red", "yellow", "green", "blue"];
    /* 10 = skip; 11 = +2; 12 = +4; 13 = wildcard 14 = draw card 15 = solid color*/
    for (let i = 0; i < 14; i++) {
      //build the number cards
      // joker_marker is true for wild cards and solid color cards -- allows solid color to be placed on wild
      let joker_marker = false;
      if (i > 12) {
        joker_marker = true;
      }
      for (let j = 0; j < 4; j++) {
        if (i < 12) {
          this.deck.push(new Card(colour[j], i, joker_marker));
        } else {
          this.deck.push(new Card("wild", i, joker_marker));
        }
      }
    }
  }
}

class Card {
  color: string = "";
  number: number = 0;
  joker: boolean = false;

  constructor(color: string, number: number, joker: boolean = false) {
    this.color = color;
    this.number = number;
    this.joker = joker;
  }
}

class Player {
  ready = false;
  player_socket: string = "";
  hand: Card[] = [];
  possible_hand: Card[] = [];
  selected_card: number = 0;
  impossible_hand: Card[] = [];

  constructor(player_socket: string) {
    this.player_socket = player_socket;
    this.hand = [];
    this.possible_hand = [];
    this.selected_card = 0;
    this.impossible_hand = [];
  }

  public checkReady(playerClient: GameClient) {
    const prev = this.ready;
    this.ready = playerClient.getCurrentPrediction() === Action.Clench;
    return [this.ready, prev !== this.ready];
  }

  public async moveCard(playerClient: GameClient, gameState: GameState) {
    while (true) {
      const action = playerClient.getCurrentPrediction();
      if (action === Action.Right) {
        this.selected_card =
          (this.selected_card + 1) % this.possible_hand.length;
        console.log("emit right")
        playerClient.socket.emit("direction", "right");
      } else if (action === Action.Left) {
        this.selected_card =
          (this.selected_card - 1 + this.possible_hand.length) %
          this.possible_hand.length;

        console.log("emit left")
        playerClient.socket.emit("direction", "left");
      } else if (action === Action.Clench) {
        return this.playCard(gameState, playerClient);
      }
      await sleep(250);
    }
  }

  // Returns true if card played (new card placed onto played cards), false if no card played (draw card)
  public playCard(gameState: GameState, playerClient: GameClient) {
    const selected = this.possible_hand[this.selected_card];
    if (selected.number != 14) {
      gameState.top_card = selected;
      this.possible_hand.splice(this.selected_card, 1);
      gameState.played_cards.push(this.possible_hand[this.selected_card]);
      this.hand.splice(this.selected_card, 1);
    } else {
      const drawn = gameState.deck.pop();
      if (drawn) {
        this.hand.push(drawn);
      }
    }
    playerClient.socket.emit("Card Played", playerClient.playerIndex, selected);
    return selected;
  }

  public sortPossibleHand(topCard: Card, playerClient: GameClient) {
    const color = topCard.color;
    const number = topCard.number;

    const hand = this.hand;

    // splice possible hand from 1 -> end, preserve draw card
    // clear everything in impossible hand
    this.possible_hand.splice(1, this.possible_hand.length - 1);
    this.impossible_hand = [];

    // Handles wild card color choice
    if (number == 12 || number == 13) {
      const colour = ["red", "yellow", "green", "blue"];
      const solidnum = 15;

      // Pops draw card
      this.possible_hand.pop();

      for (let i = 0; i < colour.length; i++) {
        this.possible_hand.push(new Card(colour[i], solidnum, true));
      }
    } else {
      // Adds draw card if doesn't exist
      if (hand.length == 0) {
        this.possible_hand.push(new Card("wild", 14, true));
      }
      for (let i = 0; i < hand.length; i++) {
        if (
          hand[i].color === color ||
          hand[i].color === "wild" ||
          hand[i].number === number
        ) {
          this.possible_hand.push(hand[i]);
        } else {
          this.impossible_hand.push(hand[i]);
        }
      }
    }
    this.selected_card = Math.floor(this.possible_hand.length / 2) // prevent out of bounds errors
    playerClient.socket.emit(
      "Possible Cards",
      this.possible_hand,
    );
    playerClient.socket.emit("Impossible Cards", this.impossible_hand);
  }
}

export { Game, GameClient, GameState, Card, Player };