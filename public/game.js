// Socket connection
const socket = io();

// Game state
let playerRole = null; // 'player1' or 'player2'
let currentRole = null; // 'attacker' or 'defender' (changes each round)
let isTracking = false;
let cameraInitialized = false;

// Head tracking state with CENTER CALIBRATION
let centerPosition = null;
let calibrationSamples = [];
let isCalibrating = false;
const CALIBRATION_TIME = 1500;

// Direction detection
const DEAD_ZONE = 0.04;
const DIRECTION_THRESHOLD = 0.08;
const REACTION_THRESHOLD = 0.06; // Slightly lower for faster reactions

// Smoothing
let smoothedPosition = null;
const SMOOTHING_FACTOR = 0.4; // Faster response for real-time

// Current move state
let currentExpectedMove = null;
let hasRespondedToMove = false;

// Camera and face detection
let video = null;
let canvas = null;
let ctx = null;
let faceDetection = null;

// DOM Elements
const notification = document.getElementById('notification');

// Initialize Camera and Face Detection
async function initCamera() {
    if (cameraInitialized) return true;

    try {
        showNotification('Initializing camera...', 2000);
        
        video = document.getElementById('webcamVideo');
        canvas = document.getElementById('faceCanvas');
        
        if (!video || !canvas) {
            console.error('Video or canvas not found');
            return false;
        }
        
        ctx = canvas.getContext('2d');

        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        });
        
        video.srcObject = stream;
        
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play();
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                resolve();
            };
        });

        faceDetection = new FaceDetection({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
        });

        faceDetection.setOptions({ model: 'short', minDetectionConfidence: 0.5 });
        faceDetection.onResults(onFaceResults);

        detectFaces();
        cameraInitialized = true;
        showNotification('Camera ready!', 1500);
        
        return true;
    } catch (error) {
        console.error('Camera error:', error);
        showNotification('Camera error. Please allow access and refresh.', 5000);
        return false;
    }
}

async function detectFaces() {
    if (video && video.readyState >= 2 && faceDetection) {
        await faceDetection.send({ image: video });
    }
    requestAnimationFrame(detectFaces);
}

function onFaceResults(results) {
    if (!ctx) return;
    
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    if (results.detections && results.detections.length > 0) {
        const detection = results.detections[0];
        const bbox = detection.boundingBox;
        
        let noseX = 0.5, noseY = 0.5;
        if (detection.landmarks && detection.landmarks.length > 2) {
            const nose = detection.landmarks[2];
            noseX = 1 - nose.x;
            noseY = nose.y;
        } else {
            noseX = 1 - bbox.xCenter;
            noseY = bbox.yCenter;
        }

        // Draw face box
        const mirroredX = canvas.width - bbox.xCenter * canvas.width - (bbox.width * canvas.width / 2);
        ctx.strokeStyle = isCalibrating ? '#ffff00' : '#ff6b6b';
        ctx.lineWidth = 3;
        ctx.strokeRect(
            mirroredX,
            bbox.yCenter * canvas.height - (bbox.height * canvas.height / 2),
            bbox.width * canvas.width,
            bbox.height * canvas.height
        );

        // Draw nose point
        ctx.fillStyle = isCalibrating ? '#ffff00' : '#00ff00';
        ctx.beginPath();
        ctx.arc(noseX * canvas.width, noseY * canvas.height, 10, 0, 2 * Math.PI);
        ctx.fill();

        // Draw center if calibrated
        if (centerPosition && !isCalibrating) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.beginPath();
            ctx.arc(centerPosition.x * canvas.width, centerPosition.y * canvas.height, 8, 0, 2 * Math.PI);
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.arc(centerPosition.x * canvas.width, centerPosition.y * canvas.height, DEAD_ZONE * canvas.width, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (isCalibrating) {
            calibrationSamples.push({ x: noseX, y: noseY });
        } else if (isTracking && centerPosition && currentExpectedMove && !hasRespondedToMove) {
            processHeadMovement(noseX, noseY);
        }
    }
}

function startCalibration() {
    isCalibrating = true;
    calibrationSamples = [];
    centerPosition = null;
    smoothedPosition = null;
    
    const status = document.getElementById('calibrationStatus');
    if (status) {
        status.textContent = 'Hold still... Calibrating...';
        status.classList.add('calibrating');
    }

    setTimeout(finishCalibration, CALIBRATION_TIME);
}

function finishCalibration() {
    if (calibrationSamples.length > 0) {
        let sumX = 0, sumY = 0;
        for (const s of calibrationSamples) {
            sumX += s.x;
            sumY += s.y;
        }
        centerPosition = { x: sumX / calibrationSamples.length, y: sumY / calibrationSamples.length };
        smoothedPosition = { ...centerPosition };
    } else {
        centerPosition = { x: 0.5, y: 0.5 };
        smoothedPosition = { x: 0.5, y: 0.5 };
    }

    isCalibrating = false;
    const status = document.getElementById('calibrationStatus');
    if (status) {
        status.textContent = 'Calibrated ✓ React to incoming moves!';
        status.classList.remove('calibrating');
    }
}

function processHeadMovement(x, y) {
    if (!centerPosition || hasRespondedToMove) return;

    // Smooth the position
    if (smoothedPosition) {
        smoothedPosition.x += SMOOTHING_FACTOR * (x - smoothedPosition.x);
        smoothedPosition.y += SMOOTHING_FACTOR * (y - smoothedPosition.y);
    } else {
        smoothedPosition = { x, y };
    }

    const deltaX = smoothedPosition.x - centerPosition.x;
    const deltaY = smoothedPosition.y - centerPosition.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    let detectedDirection = null;

    if (distance > REACTION_THRESHOLD) {
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
            detectedDirection = deltaY < 0 ? 'up' : 'down';
        } else {
            detectedDirection = deltaX < 0 ? 'left' : 'right';
        }
    }

    // Show current detection
    const indicator = document.getElementById('directionIndicator');
    if (detectedDirection && indicator) {
        const emojis = { 'up': '⬆️', 'down': '⬇️', 'left': '⬅️', 'right': '➡️' };
        indicator.textContent = emojis[detectedDirection];
        indicator.classList.add('show');

        // Lock in the move immediately on first detection (correct or wrong)
        hasRespondedToMove = true;
        socket.emit('defendMove', detectedDirection);
    } else if (indicator) {
        indicator.classList.remove('show');
    }
}

function showNotification(message, duration = 3000) {
    if (!notification) return;
    notification.textContent = message;
    notification.classList.remove('hidden');
    setTimeout(() => notification.classList.add(   'hidden'), duration);
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById(screenId);
    if (screen) screen.classList.add('active');
}

function showGameSection(sectionId) {
    document.querySelectorAll('.game-section').forEach(s => s.classList.add('hidden'));
    const section = document.getElementById(sectionId);
    if (section) section.classList.remove('hidden');
}

function updateScores(scores) {
    const playerScoreEl = document.getElementById('playerScore');
    const opponentScoreEl = document.getElementById('opponentScore');
    
    if (playerRole === 'player1') {
        if (playerScoreEl) playerScoreEl.textContent = scores.player1;
        if (opponentScoreEl) opponentScoreEl.textContent = scores.player2;
    } else {
        if (playerScoreEl) playerScoreEl.textContent = scores.player2;
        if (opponentScoreEl) opponentScoreEl.textContent = scores.player1;
    }
}

// Arrow key handling for attacker
document.addEventListener('keydown', (e) => {
    if (currentRole !== 'attacker') return;
    
    const keyMap = {
        'ArrowUp': 'up',
        'ArrowDown': 'down',
        'ArrowLeft': 'left',
        'ArrowRight': 'right'
    };
    
    const move = keyMap[e.key];
    if (move) {
        e.preventDefault();
        socket.emit('attackMove', move);
        
        // Visual feedback
        const keyId = 'key' + move.charAt(0).toUpperCase() + move.slice(1);
        const keyEl = document.getElementById(keyId);
        if (keyEl) {
            keyEl.classList.add('pressed');
            setTimeout(() => keyEl.classList.remove('pressed'), 200);
        }
    }
});

// Menu buttons
document.getElementById('createMatchBtn')?.addEventListener('click', () => {
    socket.emit('createMatch');
    document.getElementById('createMatchBtn').disabled = true;
    document.getElementById('joinMatchBtn').disabled = true;
});

document.getElementById('joinMatchBtn')?.addEventListener('click', () => {
    document.getElementById('joinForm')?.classList.remove('hidden');
    document.getElementById('matchCodeInput')?.focus();
});

document.getElementById('confirmJoinBtn')?.addEventListener('click', () => {
    const code = document.getElementById('matchCodeInput')?.value.trim();
    if (code && code.length === 6) {
        socket.emit('joinMatch', code);
    } else {
        showNotification('Enter a valid 6-character code');
    }
});

document.getElementById('matchCodeInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('confirmJoinBtn')?.click();
});

document.getElementById('rematchBtn')?.addEventListener('click', function() {
    socket.emit('proposeRematch');
    this.disabled = true;
    const status = document.getElementById('rematchStatus');
    if (status) {
        status.classList.remove('hidden');
        status.textContent = 'Waiting for opponent...';
    }
});

document.getElementById('exitMatchBtn')?.addEventListener('click', () => location.reload());

// Socket events
socket.on('matchCreated', ({ matchCode }) => {
    playerRole = 'player1';
    const codeEl = document.getElementById('generatedCode');
    if (codeEl) codeEl.textContent = matchCode;
    document.getElementById('matchCodeDisplay')?.classList.remove('hidden');
});

socket.on('joinError', ({ message }) => showNotification(message));

socket.on('matchStarted', () => {
    showScreen('gameScreen');
    showNotification('Match started!');
});

socket.on('roundStart', async ({ round, totalRounds, role, countdownSeconds }) => {
    currentRole = role;
    
    document.getElementById('currentRound').textContent = round;
    document.getElementById('totalRounds').textContent = totalRounds;
    
    const announcement = document.getElementById('roleAnnouncement');
    const description = document.getElementById('roleDescription');
    
    if (role === 'attacker') {
        if (announcement) announcement.textContent = '⚔️ You are ATTACKING!';
        if (description) description.textContent = 'Use arrow keys to send moves!';
    } else {
        if (announcement) announcement.textContent = '🛡️ You are DEFENDING!';
        if (description) description.textContent = 'React to moves with your head!';
        
        // Start camera early for defender
        if (!cameraInitialized) {
            await initCamera();
        }
    }
    
    showGameSection('countdownScreen');
});

socket.on('countdown', ({ count }) => {
    const el = document.getElementById('countdownNumber');
    if (el) el.textContent = count === 0 ? 'GO!' : count;
});

socket.on('startAttacking', ({ duration, round }) => {
    currentRole = 'attacker';
    showGameSection('attackerScreen');
    
    const lastMove = document.getElementById('lastMoveSent');
    if (lastMove) lastMove.textContent = '-';
    
    document.getElementById('opponentReaction')?.classList.add('hidden');
});

socket.on('startDefending', async ({ duration, round }) => {
    currentRole = 'defender';
    showGameSection('defenderScreen');
    
    if (!cameraInitialized) {
        await initCamera();
    }
    
    // Start calibration and tracking
    startCalibration();
    setTimeout(() => {
        isTracking = true;
    }, CALIBRATION_TIME);
    
    const incoming = document.getElementById('incomingMove');
    if (incoming) incoming.textContent = '-';
});

socket.on('roundTimer', ({ timeLeft }) => {
    const timer = document.getElementById('roundTimer');
    if (timer) timer.textContent = timeLeft;
});

socket.on('moveSent', ({ direction }) => {
    const emojis = { 'up': '⬆️', 'down': '⬇️', 'left': '⬅️', 'right': '➡️' };
    const lastMove = document.getElementById('lastMoveSent');
    if (lastMove) lastMove.textContent = emojis[direction];
});

socket.on('incomingMove', ({ direction, reactionTime }) => {
    currentExpectedMove = direction;
    hasRespondedToMove = false;
    
    const emojis = { 'up': '⬆️', 'down': '⬇️', 'left': '⬅️', 'right': '➡️' };
    const incoming = document.getElementById('incomingMove');
    if (incoming) {
        incoming.textContent = emojis[direction];
        incoming.classList.add('pulse');
        setTimeout(() => incoming.classList.remove('pulse'), 300);
    }
    
    // Show reaction timer
    const timerEl = document.getElementById('reactionTimer');
    const barEl = document.getElementById('reactionTimerBar');
    if (timerEl && barEl) {
        timerEl.classList.remove('hidden');
        barEl.style.animation = 'none';
        barEl.offsetHeight; // Trigger reflow
        barEl.style.animation = `shrink ${reactionTime}ms linear forwards`;
    }
});

socket.on('moveMissed', ({ direction }) => {
    currentExpectedMove = null;
    hasRespondedToMove = false;
    
    const incoming = document.getElementById('incomingMove');
    if (incoming) incoming.textContent = '❌';
    
    const feedback = document.getElementById('defenderFeedback');
    const text = document.getElementById('feedbackText');
    if (feedback && text) {
        text.textContent = 'MISSED!';
        feedback.className = 'defender-feedback incorrect';
        feedback.classList.remove('hidden');
        setTimeout(() => feedback.classList.add('hidden'), 1000);
    }
    
    document.getElementById('reactionTimer')?.classList.add('hidden');
});

socket.on('moveResult', ({ expected, detected, correct, reactionTime, scores }) => {
    currentExpectedMove = null;
    updateScores(scores);
    
    const feedback = document.getElementById('defenderFeedback');
    const text = document.getElementById('feedbackText');
    if (feedback && text) {
        if (correct) {
            text.textContent = `✓ ${reactionTime}ms`;
            feedback.className = 'defender-feedback correct';
        } else {
            text.textContent = '✗ Wrong move!';
            feedback.className = 'defender-feedback incorrect';
        }
        feedback.classList.remove('hidden');
        setTimeout(() => feedback.classList.add('hidden'), 1000);
    }
    
    document.getElementById('reactionTimer')?.classList.add('hidden');
});

socket.on('opponentResult', ({ expected, detected, correct, scores }) => {
    updateScores(scores);
    
    const reaction = document.getElementById('opponentReaction');
    const result = document.getElementById('reactionResult');
    if (reaction && result) {
        result.textContent = correct ? '✓ Opponent matched!' : '✗ Opponent missed!';
        result.className = correct ? 'correct' : 'incorrect';
        reaction.classList.remove('hidden');
        setTimeout(() => reaction.classList.add('hidden'), 1500);
    }
});

socket.on('opponentMissed', ({ direction }) => {
    const reaction = document.getElementById('opponentReaction');
    const result = document.getElementById('reactionResult');
    if (reaction && result) {
        result.textContent = '✗ Opponent too slow!';
        result.className = 'incorrect';
        reaction.classList.remove('hidden');
        setTimeout(() => reaction.classList.add('hidden'), 1500);
    }
});

socket.on('roundEnd', ({ round, scores }) => {
    isTracking = false;
    currentExpectedMove = null;
    
    showGameSection('roundEndScreen');
    
    if (playerRole === 'player1') {
        document.getElementById('roundYourScore').textContent = scores.player1;
        document.getElementById('roundOpponentScore').textContent = scores.player2;
    } else {
        document.getElementById('roundYourScore').textContent = scores.player2;
        document.getElementById('roundOpponentScore').textContent = scores.player1;
    }
});

socket.on('matchEnd', ({ scores, winner }) => {
    isTracking = false;
    showGameSection('matchEndScreen');
    
    if (playerRole === 'player1') {
        document.getElementById('finalPlayerScore').textContent = scores.player1;
        document.getElementById('finalOpponentScore').textContent = scores.player2;
    } else {
        document.getElementById('finalPlayerScore').textContent = scores.player2;
        document.getElementById('finalOpponentScore').textContent = scores.player1;
    }
    
    const title = document.getElementById('matchResultTitle');
    const isWinner = (playerRole === 'player1' && winner === 'player1') || 
                     (playerRole === 'player2' && winner === 'player2');
    
    if (winner === 'tie') {
        title.textContent = "It's a Tie!";
        title.className = '';
    } else if (isWinner) {
        title.textContent = 'You Win! 🎉';
        title.className = 'winner';
    } else {
        title.textContent = 'You Lose 😢';
        title.className = 'loser';
    }
    
    document.getElementById('rematchBtn').disabled = false;
    document.getElementById('rematchStatus')?.classList.add('hidden');
});

socket.on('rematchProposed', () => showNotification('Opponent wants a rematch!'));

socket.on('rematchStarting', () => {
    showNotification('Rematch starting!');
    document.getElementById('playerScore').textContent = '0';
    document.getElementById('opponentScore').textContent = '0';
});

socket.on('opponentDisconnected', () => {
    showNotification('Opponent disconnected!');
    setTimeout(() => location.reload(), 2000);
});

console.log('Shadow Boxing Real-Time Game initialized');
