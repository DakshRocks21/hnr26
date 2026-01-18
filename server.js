const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active matches
const matches = new Map();

// Generate a 6-character match code
function generateMatchCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create a new match
    socket.on('createMatch', () => {
        const matchCode = generateMatchCode();
        const match = {
            code: matchCode,
            player1: socket.id,
            player2: null,
            currentRound: 1,
            totalRounds: 3,
            scores: { player1: 0, player2: 0 },
            combination: null,
            state: 'waiting',
            rematchProposals: { player1: false, player2: false }
        };
        
        matches.set(matchCode, match);
        socket.join(matchCode);
        socket.matchCode = matchCode;
        socket.playerRole = 'player1';
        
        socket.emit('matchCreated', { matchCode });
        console.log(`Match created: ${matchCode} by ${socket.id}`);
    });

    // Join an existing match
    socket.on('joinMatch', (matchCode) => {
        const code = matchCode.toUpperCase();
        const match = matches.get(code);
        
        if (!match) {
            socket.emit('joinError', { message: 'Match not found' });
            return;
        }
        
        if (match.player2) {
            socket.emit('joinError', { message: 'Match is full' });
            return;
        }
        
        match.player2 = socket.id;
        socket.join(code);
        socket.matchCode = code;
        socket.playerRole = 'player2';
        
        io.to(code).emit('matchStarted', {
            matchCode: code,
            player1: match.player1,
            player2: match.player2
        });
        
        match.state = 'inputting';
        io.to(match.player1).emit('inputCombination', { round: match.currentRound });
        io.to(match.player2).emit('waitingForCombination', { round: match.currentRound });
        
        console.log(`Player joined match: ${code}`);
    });

    // Player 1 submits their combination
    socket.on('submitCombination', (combination) => {
        const match = matches.get(socket.matchCode);
        if (!match || socket.playerRole !== 'player1') return;
        
        if (combination.length !== 4) {
            socket.emit('combinationError', { message: 'Combination must have 4 moves' });
            return;
        }
        
        match.combination = combination;
        match.state = 'countdown';
        
        io.to(match.player2).emit('getReady', { 
            round: match.currentRound,
            countdownSeconds: 3
        });
        
        io.to(match.player1).emit('watchingOpponent', { round: match.currentRound });
        
        let countdown = 3;
        const countdownInterval = setInterval(() => {
            io.to(socket.matchCode).emit('countdown', { count: countdown });
            countdown--;
            
            if (countdown < 0) {
                clearInterval(countdownInterval);
                match.state = 'guessing';
                io.to(match.player2).emit('startGuessing', { 
                    duration: 8,
                    round: match.currentRound
                });
                io.to(match.player1).emit('opponentGuessing', { duration: 8 });
            }
        }, 1000);
    });

    // Player 2 submits their guesses
    socket.on('submitGuess', (guessedMoves) => {
        const match = matches.get(socket.matchCode);
        if (!match || socket.playerRole !== 'player2') return;
        
        let correctMoves = 0;
        const results = [];
        
        for (let i = 0; i < 4; i++) {
            const isCorrect = guessedMoves[i] === match.combination[i];
            if (isCorrect) correctMoves++;
            results.push({
                expected: match.combination[i],
                guessed: guessedMoves[i] || 'none',
                correct: isCorrect
            });
        }
        
        match.scores.player2 += correctMoves;
        match.state = 'roundEnd';
        
        io.to(socket.matchCode).emit('roundResult', {
            round: match.currentRound,
            combination: match.combination,
            guesses: guessedMoves,
            results: results,
            correctMoves: correctMoves,
            scores: match.scores
        });
        
        if (match.currentRound >= match.totalRounds) {
            match.state = 'matchEnd';
            const winner = match.scores.player1 > match.scores.player2 ? 'player1' : 
                          match.scores.player2 > match.scores.player1 ? 'player2' : 'tie';
            
            io.to(socket.matchCode).emit('matchEnd', {
                scores: match.scores,
                winner: winner
            });
        } else {
            setTimeout(() => {
                match.currentRound++;
                match.combination = null;
                match.state = 'inputting';
                
                io.to(match.player1).emit('inputCombination', { round: match.currentRound });
                io.to(match.player2).emit('waitingForCombination', { round: match.currentRound });
            }, 3000);
        }
    });

    // Handle rematch proposal
    socket.on('proposeRematch', () => {
        const match = matches.get(socket.matchCode);
        if (!match || match.state !== 'matchEnd') return;
        
        if (socket.playerRole === 'player1') {
            match.rematchProposals.player1 = true;
            io.to(match.player2).emit('rematchProposed', { by: 'player1' });
        } else {
            match.rematchProposals.player2 = true;
            io.to(match.player1).emit('rematchProposed', { by: 'player2' });
        }
        
        if (match.rematchProposals.player1 && match.rematchProposals.player2) {
            match.currentRound = 1;
            match.scores = { player1: 0, player2: 0 };
            match.combination = null;
            match.rematchProposals = { player1: false, player2: false };
            match.state = 'inputting';
            
            io.to(socket.matchCode).emit('rematchStarting');
            
            setTimeout(() => {
                io.to(match.player1).emit('inputCombination', { round: match.currentRound });
                io.to(match.player2).emit('waitingForCombination', { round: match.currentRound });
            }, 1000);
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.matchCode) {
            const match = matches.get(socket.matchCode);
            if (match) {
                io.to(socket.matchCode).emit('opponentDisconnected');
                matches.delete(socket.matchCode);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
