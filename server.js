const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const matches = new Map();

function generateMatchCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createMatch', () => {
        const matchCode = generateMatchCode();
        const match = {
            code: matchCode,
            player1: socket.id,
            player2: null,
            currentRound: 1,
            totalRounds: 4,
            scores: { player1: 0, player2: 0 },
            state: 'waiting',
            // In odd rounds (1,3): player1 attacks, player2 defends
            // In even rounds (2,4): player2 attacks, player1 defends
            currentAttacker: null,
            currentDefender: null,
            roundTimer: null,
            currentMove: null,
            moveTimeout: null,
            rematchProposals: { player1: false, player2: false }
        };
        
        matches.set(matchCode, match);
        socket.join(matchCode);
        socket.matchCode = matchCode;
        socket.playerRole = 'player1';
        
        socket.emit('matchCreated', { matchCode });
        console.log(`Match created: ${matchCode}`);
    });

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
        
        // Notify both players match started
        io.to(code).emit('matchStarted', {
            matchCode: code,
            player1: match.player1,
            player2: match.player2
        });
        
        console.log(`Player joined match: ${code}`);
        
        // Start countdown for first round
        startRoundCountdown(code);
    });

    // Start round countdown
    function startRoundCountdown(matchCode) {
        const match = matches.get(matchCode);
        if (!match) return;

        // Determine attacker/defender for this round
        const isOddRound = match.currentRound % 2 === 1;
        match.currentAttacker = isOddRound ? match.player1 : match.player2;
        match.currentDefender = isOddRound ? match.player2 : match.player1;

        match.state = 'countdown';

        // Tell both players about roles
        io.to(match.currentAttacker).emit('roundStart', {
            round: match.currentRound,
            totalRounds: match.totalRounds,
            role: 'attacker',
            countdownSeconds: 3
        });

        io.to(match.currentDefender).emit('roundStart', {
            round: match.currentRound,
            totalRounds: match.totalRounds,
            role: 'defender',
            countdownSeconds: 3
        });

        // Countdown
        let count = 3;
        const countdownInterval = setInterval(() => {
            io.to(matchCode).emit('countdown', { count });
            count--;
            
            if (count < 0) {
                clearInterval(countdownInterval);
                startRound(matchCode);
            }
        }, 1000);
    }

    // Start the actual round
    function startRound(matchCode) {
        const match = matches.get(matchCode);
        if (!match) return;

        match.state = 'playing';
        match.currentMove = null;

        // Tell players to start
        io.to(match.currentAttacker).emit('startAttacking', {
            duration: 30,
            round: match.currentRound
        });

        io.to(match.currentDefender).emit('startDefending', {
            duration: 30,
            round: match.currentRound
        });

        // Round timer - 30 seconds
        let timeLeft = 30;
        match.roundTimer = setInterval(() => {
            timeLeft--;
            io.to(matchCode).emit('roundTimer', { timeLeft });

            if (timeLeft <= 0) {
                endRound(matchCode);
            }
        }, 1000);
    }

    // Attacker sends a move
    socket.on('attackMove', (move) => {
        const match = matches.get(socket.matchCode);
        if (!match || match.state !== 'playing') return;
        if (socket.id !== match.currentAttacker) return;

        // Clear any existing move timeout
        if (match.moveTimeout) {
            clearTimeout(match.moveTimeout);
        }

        match.currentMove = {
            direction: move,
            timestamp: Date.now(),
            responded: false
        };

        // Send move to defender immediately
        io.to(match.currentDefender).emit('incomingMove', {
            direction: move,
            reactionTime: 2000 // 2 seconds to react
        });

        // Show attacker their move was sent
        io.to(match.currentAttacker).emit('moveSent', { direction: move });

        // Set timeout for this move (2 seconds)
        match.moveTimeout = setTimeout(() => {
            if (match.currentMove && !match.currentMove.responded) {
                // Time's up for this move
                io.to(match.currentDefender).emit('moveMissed', { direction: move });
                io.to(match.currentAttacker).emit('opponentMissed', { direction: move });
                match.currentMove = null;
            }
        }, 2000);
    });

    // Defender responds with their detected move
    socket.on('defendMove', (detectedMove) => {
        const match = matches.get(socket.matchCode);
        if (!match || match.state !== 'playing') return;
        if (socket.id !== match.currentDefender) return;
        if (!match.currentMove || match.currentMove.responded) return;

        match.currentMove.responded = true;
        const expectedMove = match.currentMove.direction;
        const isCorrect = detectedMove === expectedMove;
        const reactionTime = Date.now() - match.currentMove.timestamp;

        if (isCorrect) {
            // Award point to defender
            if (match.currentDefender === match.player1) {
                match.scores.player1++;
            } else {
                match.scores.player2++;
            }
        }

        // Clear the move timeout
        if (match.moveTimeout) {
            clearTimeout(match.moveTimeout);
            match.moveTimeout = null;
        }

        // Notify both players
        io.to(match.currentDefender).emit('moveResult', {
            expected: expectedMove,
            detected: detectedMove,
            correct: isCorrect,
            reactionTime,
            scores: match.scores
        });

        io.to(match.currentAttacker).emit('opponentResult', {
            expected: expectedMove,
            detected: detectedMove,
            correct: isCorrect,
            reactionTime,
            scores: match.scores
        });

        match.currentMove = null;
    });

    // End the current round
    function endRound(matchCode) {
        const match = matches.get(matchCode);
        if (!match) return;

        // Clear timers
        if (match.roundTimer) {
            clearInterval(match.roundTimer);
            match.roundTimer = null;
        }
        if (match.moveTimeout) {
            clearTimeout(match.moveTimeout);
            match.moveTimeout = null;
        }

        match.state = 'roundEnd';

        io.to(matchCode).emit('roundEnd', {
            round: match.currentRound,
            scores: match.scores
        });

        // Check if match is over
        if (match.currentRound >= match.totalRounds) {
            setTimeout(() => endMatch(matchCode), 2000);
        } else {
            // Next round after delay
            setTimeout(() => {
                match.currentRound++;
                startRoundCountdown(matchCode);
            }, 3000);
        }
    }

    // End the match
    function endMatch(matchCode) {
        const match = matches.get(matchCode);
        if (!match) return;

        match.state = 'matchEnd';
        
        let winner = 'tie';
        if (match.scores.player1 > match.scores.player2) {
            winner = 'player1';
        } else if (match.scores.player2 > match.scores.player1) {
            winner = 'player2';
        }

        io.to(matchCode).emit('matchEnd', {
            scores: match.scores,
            winner
        });
    }

    // Handle rematch
    socket.on('proposeRematch', () => {
        const match = matches.get(socket.matchCode);
        if (!match || match.state !== 'matchEnd') return;

        if (socket.playerRole === 'player1') {
            match.rematchProposals.player1 = true;
            io.to(match.player2).emit('rematchProposed');
        } else {
            match.rematchProposals.player2 = true;
            io.to(match.player1).emit('rematchProposed');
        }

        if (match.rematchProposals.player1 && match.rematchProposals.player2) {
            // Reset match
            match.currentRound = 1;
            match.scores = { player1: 0, player2: 0 };
            match.rematchProposals = { player1: false, player2: false };
            
            io.to(socket.matchCode).emit('rematchStarting');
            
            setTimeout(() => {
                startRoundCountdown(socket.matchCode);
            }, 1000);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.matchCode) {
            const match = matches.get(socket.matchCode);
            if (match) {
                if (match.roundTimer) clearInterval(match.roundTimer);
                if (match.moveTimeout) clearTimeout(match.moveTimeout);
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
