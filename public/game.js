// Socket connection
const socket = io();

// Game state
let playerRole = null;
let currentCombination = [];
let detectedMoves = [];
let isTracking = false;
let cameraInitialized = false;

// Head tracking state with CENTER CALIBRATION
let centerPosition = null;           // The calibrated center position
let calibrationSamples = [];         // Samples collected during calibration
let isCalibrating = false;           // Whether we're currently calibrating
const CALIBRATION_SAMPLES = 30;      // Number of samples to average for center
const CALIBRATION_TIME = 1500;       // Time in ms to calibrate (1.5 seconds)

// Direction detection with DEAD ZONE
const DEAD_ZONE = 0.04;              // Dead zone around center (normalized 0-1)
const DIRECTION_THRESHOLD = 0.08;    // Threshold to register a direction (beyond dead zone)
const HOLD_TIME_REQUIRED = 350;      // ms to confirm direction

// Smoothing
let smoothedPosition = null;
const SMOOTHING_FACTOR = 0.3;        // Lower = more smoothing

// Direction state
let lastDirection = null;
let directionHoldTime = 0;
let lastUpdateTime = 0;

// Camera and face detection
let video = null;
let canvas = null;
let ctx = null;
let faceDetection = null;

// DOM Elements
const menuScreen = document.getElementById('menuScreen');
const gameScreen = document.getElementById('gameScreen');
const createMatchBtn = document.getElementById('createMatchBtn');
const joinMatchBtn = document.getElementById('joinMatchBtn');
const joinForm = document.getElementById('joinForm');
const matchCodeInput = document.getElementById('matchCodeInput');
const confirmJoinBtn = document.getElementById('confirmJoinBtn');
const matchCodeDisplay = document.getElementById('matchCodeDisplay');
const generatedCode = document.getElementById('generatedCode');

// Game elements
const combinationInput = document.getElementById('combinationInput');
const waitingScreen = document.getElementById('waitingScreen');
const countdownScreen = document.getElementById('countdownScreen');
const trackingScreen = document.getElementById('trackingScreen');
const watchingScreen = document.getElementById('watchingScreen');
const resultScreen = document.getElementById('resultScreen');
const matchEndScreen = document.getElementById('matchEndScreen');

const selectedMoves = document.getElementById('selectedMoves');
const moveButtons = document.querySelectorAll('.move-btn');
const clearMovesBtn = document.getElementById('clearMovesBtn');
const submitCombinationBtn = document.getElementById('submitCombinationBtn');
const countdownNumber = document.getElementById('countdownNumber');
const timerDisplay = document.getElementById('timerDisplay');
const detectedMovesDisplay = document.getElementById('detectedMoves');
const notification = document.getElementById('notification');

// Initialize Camera and Face Detection
async function initCamera() {
    if (cameraInitialized) {
        return true;
    }

    try {
        showNotification('Initializing camera...', 3000);
        
        video = document.getElementById('webcamVideo');
        canvas = document.getElementById('faceCanvas');
        ctx = canvas.getContext('2d');

        // Request camera access
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'user'
            }
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

        // Initialize MediaPipe Face Detection
        faceDetection = new FaceDetection({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
            }
        });

        faceDetection.setOptions({
            model: 'short',
            minDetectionConfidence: 0.5
        });

        faceDetection.onResults(onFaceResults);

        // Start detection loop
        detectFaces();

        cameraInitialized = true;
        showNotification('Camera ready!', 2000);
        
        return true;
    } catch (error) {
        console.error('Error initializing camera:', error);
        showNotification('Error accessing camera. Please allow camera access and refresh.', 5000);
        return false;
    }
}

// Face detection loop
async function detectFaces() {
    if (video && video.readyState >= 2 && faceDetection) {
        await faceDetection.send({ image: video });
    }
    requestAnimationFrame(detectFaces);
}

// Process face detection results
function onFaceResults(results) {
    // Clear and draw mirrored video
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    if (results.detections && results.detections.length > 0) {
        const detection = results.detections[0];
        const bbox = detection.boundingBox;
        
        // Get nose position for tracking
        let noseX = 0.5, noseY = 0.5;
        if (detection.landmarks && detection.landmarks.length > 2) {
            const nose = detection.landmarks[2];
            noseX = 1 - nose.x; // Mirror X
            noseY = nose.y;
        } else {
            // Fallback to center of bounding box
            noseX = 1 - bbox.xCenter;
            noseY = bbox.yCenter;
        }

        // Draw face box (mirrored)
        const mirroredX = canvas.width - bbox.xCenter * canvas.width - (bbox.width * canvas.width / 2);
        ctx.strokeStyle = isCalibrating ? '#ffff00' : '#ff6b6b';
        ctx.lineWidth = 3;
        ctx.strokeRect(
            mirroredX,
            bbox.yCenter * canvas.height - (bbox.height * canvas.height / 2),
            bbox.width * canvas.width,
            bbox.height * canvas.height
        );

        // Draw nose tracking point
        ctx.fillStyle = isCalibrating ? '#ffff00' : '#00ff00';
        ctx.beginPath();
        ctx.arc(noseX * canvas.width, noseY * canvas.height, 10, 0, 2 * Math.PI);
        ctx.fill();

        // Draw center reference if calibrated
        if (centerPosition && !isCalibrating) {
            // Draw center point
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.beginPath();
            ctx.arc(centerPosition.x * canvas.width, centerPosition.y * canvas.height, 8, 0, 2 * Math.PI);
            ctx.fill();

            // Draw dead zone circle
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.arc(
                centerPosition.x * canvas.width, 
                centerPosition.y * canvas.height, 
                DEAD_ZONE * canvas.width, 
                0, 2 * Math.PI
            );
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw direction threshold circle
            ctx.strokeStyle = 'rgba(255, 107, 107, 0.3)';
            ctx.beginPath();
            ctx.arc(
                centerPosition.x * canvas.width, 
                centerPosition.y * canvas.height, 
                DIRECTION_THRESHOLD * canvas.width, 
                0, 2 * Math.PI
            );
            ctx.stroke();
        }

        // Process position
        if (isCalibrating) {
            collectCalibrationSample(noseX, noseY);
        } else if (isTracking && centerPosition) {
            processHeadPosition(noseX, noseY);
        }
    }
}

// Start calibration to find center position
function startCalibration() {
    isCalibrating = true;
    calibrationSamples = [];
    centerPosition = null;
    smoothedPosition = null;
    
    const calibrationStatus = document.getElementById('calibrationStatus');
    if (calibrationStatus) {
        calibrationStatus.textContent = 'Hold still... Calibrating center position...';
        calibrationStatus.classList.add('calibrating');
    }

    showNotification('Hold your head still to calibrate...', CALIBRATION_TIME);

    // End calibration after timeout
    setTimeout(() => {
        finishCalibration();
    }, CALIBRATION_TIME);
}

// Collect calibration samples
function collectCalibrationSample(x, y) {
    calibrationSamples.push({ x, y });
}

// Finish calibration and compute center
function finishCalibration() {
    if (calibrationSamples.length > 0) {
        // Average all samples to get center
        let sumX = 0, sumY = 0;
        for (const sample of calibrationSamples) {
            sumX += sample.x;
            sumY += sample.y;
        }
        centerPosition = {
            x: sumX / calibrationSamples.length,
            y: sumY / calibrationSamples.length
        };
        smoothedPosition = { ...centerPosition };

        console.log('Calibrated center:', centerPosition);
        showNotification('Center calibrated! Start moving your head.', 2000);
    } else {
        // Fallback to screen center
        centerPosition = { x: 0.5, y: 0.5 };
        smoothedPosition = { x: 0.5, y: 0.5 };
        showNotification('Using default center position.', 2000);
    }

    isCalibrating = false;
    
    const calibrationStatus = document.getElementById('calibrationStatus');
    if (calibrationStatus) {
        calibrationStatus.textContent = 'Center calibrated ✓ Move your head to detect directions';
        calibrationStatus.classList.remove('calibrating');
    }
}

// Process head position for direction detection
function processHeadPosition(x, y) {
    if (!isTracking || !centerPosition || detectedMoves.length >= 4) return;

    const currentTime = Date.now();

    // Apply smoothing to reduce noise
    if (smoothedPosition) {
        smoothedPosition.x = smoothedPosition.x + SMOOTHING_FACTOR * (x - smoothedPosition.x);
        smoothedPosition.y = smoothedPosition.y + SMOOTHING_FACTOR * (y - smoothedPosition.y);
    } else {
        smoothedPosition = { x, y };
    }

    // Calculate displacement from CENTER
    const deltaX = smoothedPosition.x - centerPosition.x;
    const deltaY = smoothedPosition.y - centerPosition.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Determine direction based on displacement from CENTER
    let direction = null;

    // Only register direction if outside dead zone
    if (distance > DEAD_ZONE) {
        // Check if far enough for direction
        if (distance > DIRECTION_THRESHOLD) {
            // Determine primary direction based on largest delta
            if (Math.abs(deltaY) > Math.abs(deltaX)) {
                direction = deltaY < 0 ? 'up' : 'down';
            } else {
                direction = deltaX < 0 ? 'left' : 'right';
            }
        }
    }

    // Update direction indicator
    const directionIndicator = document.getElementById('directionIndicator');
    const gazeDirection = document.getElementById('gazeDirection');
    
    if (direction) {
        const directionEmoji = {
            'up': '⬆️',
            'down': '⬇️',
            'left': '⬅️',
            'right': '➡️'
        };

        directionIndicator.textContent = directionEmoji[direction];
        directionIndicator.classList.add('show');
        
        if (gazeDirection) {
            gazeDirection.textContent = `${direction.toUpperCase()} (${(distance * 100).toFixed(0)}%)`;
            gazeDirection.classList.add('show');
        }

        // Check if holding the same direction
        if (direction === lastDirection) {
            directionHoldTime += (currentTime - lastUpdateTime);

            if (directionHoldTime >= HOLD_TIME_REQUIRED) {
                // Only register if it's different from the last registered move
                const lastRegistered = detectedMoves[detectedMoves.length - 1];
                if (lastRegistered !== direction) {
                    detectedMoves.push(direction);
                    updateDetectedMovesDisplay();
                    showNotification(`Move ${detectedMoves.length}: ${direction.toUpperCase()} ✓`, 1000);

                    // Flash effect
                    directionIndicator.style.background = 'rgba(76, 175, 80, 0.8)';
                    setTimeout(() => {
                        directionIndicator.style.background = 'rgba(0, 0, 0, 0.6)';
                    }, 200);

                    // Reset for next move - require returning toward center
                    directionHoldTime = 0;
                    lastDirection = null;
                }
            }
        } else {
            lastDirection = direction;
            directionHoldTime = 0;
        }
    } else {
        directionIndicator.classList.remove('show');
        if (gazeDirection) {
            gazeDirection.textContent = `In center zone`;
            gazeDirection.classList.remove('show');
        }
        lastDirection = null;
        directionHoldTime = 0;
    }

    lastUpdateTime = currentTime;
}

function updateDetectedMovesDisplay() {
    const slots = detectedMovesDisplay.querySelectorAll('.move-slot');
    const moveEmojis = {
        'up': '⬆️',
        'down': '⬇️',
        'left': '⬅️',
        'right': '➡️'
    };

    slots.forEach((slot, index) => {
        if (detectedMoves[index]) {
            slot.textContent = moveEmojis[detectedMoves[index]];
            slot.classList.add('filled');
        } else {
            slot.textContent = '?';
            slot.classList.remove('filled');
        }
    });
}

// Reset tracking state
function resetTrackingState() {
    centerPosition = null;
    calibrationSamples = [];
    isCalibrating = false;
    smoothedPosition = null;
    lastDirection = null;
    directionHoldTime = 0;
    detectedMoves = [];
}

// Show notification
function showNotification(message, duration = 3000) {
    notification.textContent = message;
    notification.classList.remove('hidden');

    setTimeout(() => {
        notification.classList.add('hidden');
    }, duration);
}

// Switch screens
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function showGameSection(sectionId) {
    document.querySelectorAll('.game-section').forEach(s => s.classList.add('hidden'));
    document.getElementById(sectionId).classList.remove('hidden');
}

// Update combination display
function updateCombinationDisplay() {
    const slots = selectedMoves.querySelectorAll('.move-slot');
    const moveEmojis = {
        'up': '⬆️',
        'down': '⬇️',
        'left': '⬅️',
        'right': '➡️'
    };

    slots.forEach((slot, index) => {
        if (currentCombination[index]) {
            slot.textContent = moveEmojis[currentCombination[index]];
            slot.classList.add('filled');
        } else {
            slot.textContent = '?';
            slot.classList.remove('filled');
        }
    });

    submitCombinationBtn.disabled = currentCombination.length !== 4;
}

// Event Listeners - Menu
createMatchBtn.addEventListener('click', () => {
    socket.emit('createMatch');
    createMatchBtn.disabled = true;
    joinMatchBtn.disabled = true;
});

joinMatchBtn.addEventListener('click', () => {
    joinForm.classList.remove('hidden');
    matchCodeInput.focus();
});

confirmJoinBtn.addEventListener('click', () => {
    const code = matchCodeInput.value.trim();
    if (code.length === 6) {
        socket.emit('joinMatch', code);
    } else {
        showNotification('Please enter a valid 6-character code');
    }
});

matchCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        confirmJoinBtn.click();
    }
});

// Event Listeners - Combination Input
moveButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (currentCombination.length < 4) {
            currentCombination.push(btn.dataset.move);
            updateCombinationDisplay();
        }
    });
});

clearMovesBtn.addEventListener('click', () => {
    currentCombination = [];
    updateCombinationDisplay();
});

submitCombinationBtn.addEventListener('click', () => {
    if (currentCombination.length === 4) {
        socket.emit('submitCombination', currentCombination);
    }
});

// Event Listeners - Match End
document.getElementById('rematchBtn').addEventListener('click', function() {
    socket.emit('proposeRematch');
    this.disabled = true;
    document.getElementById('rematchStatus').classList.remove('hidden');
    document.getElementById('rematchStatus').textContent = 'Waiting for opponent...';
});

document.getElementById('exitMatchBtn').addEventListener('click', () => {
    location.reload();
});

// Socket Event Handlers
socket.on('matchCreated', ({ matchCode }) => {
    playerRole = 'player1';
    generatedCode.textContent = matchCode;
    matchCodeDisplay.classList.remove('hidden');
});

socket.on('joinError', ({ message }) => {
    showNotification(message);
});

socket.on('matchStarted', ({ matchCode }) => {
    showScreen('gameScreen');
    showNotification('Match started!');
});

socket.on('inputCombination', ({ round }) => {
    document.getElementById('currentRound').textContent = round;
    currentCombination = [];
    updateCombinationDisplay();
    showGameSection('combinationInput');
});

socket.on('waitingForCombination', ({ round }) => {
    document.getElementById('currentRound').textContent = round;
    document.getElementById('waitingText').textContent = 'Waiting for opponent to set combination...';
    showGameSection('waitingScreen');
    
    // Pre-initialize camera while waiting
    if (!cameraInitialized) {
        initCamera();
    }
});

socket.on('getReady', async ({ round, countdownSeconds }) => {
    showGameSection('countdownScreen');
    
    // Initialize camera if not already done
    if (!cameraInitialized) {
        await initCamera();
    }
    
    // Start calibration during countdown
    resetTrackingState();
    startCalibration();
});

socket.on('countdown', ({ count }) => {
    countdownNumber.textContent = count;
    if (count === 0) {
        countdownNumber.textContent = 'GO!';
    }
});

socket.on('startGuessing', async ({ duration }) => {
    showGameSection('trackingScreen');

    // Reset detected moves
    detectedMoves = [];
    lastDirection = null;
    directionHoldTime = 0;
    lastUpdateTime = Date.now();
    updateDetectedMovesDisplay();

    // Start tracking (calibration should be done by now)
    isTracking = true;

    // Timer countdown
    let timeLeft = duration;
    timerDisplay.textContent = timeLeft;

    const timerInterval = setInterval(() => {
        timeLeft--;
        timerDisplay.textContent = timeLeft;

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            isTracking = false;

            // Fill remaining moves with 'none' if not detected
            while (detectedMoves.length < 4) {
                detectedMoves.push('none');
            }

            socket.emit('submitGuess', detectedMoves);
        }
    }, 1000);
});

socket.on('watchingOpponent', ({ round }) => {
    const yourCombination = document.getElementById('yourCombination');
    const slots = yourCombination.querySelectorAll('.move-slot');
    const moveEmojis = {
        'up': '⬆️',
        'down': '⬇️',
        'left': '⬅️',
        'right': '➡️'
    };

    slots.forEach((slot, index) => {
        slot.textContent = moveEmojis[currentCombination[index]] || '?';
    });

    showGameSection('watchingScreen');
});

socket.on('opponentGuessing', ({ duration }) => {
    let timeLeft = duration + 3;
    const watchTimer = document.getElementById('watchTimer');
    watchTimer.textContent = timeLeft;

    const timerInterval = setInterval(() => {
        timeLeft--;
        watchTimer.textContent = Math.max(0, timeLeft);

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
        }
    }, 1000);
});

socket.on('roundResult', ({ round, combination, guesses, results, correctMoves, scores }) => {
    showGameSection('resultScreen');
    isTracking = false;

    if (playerRole === 'player1') {
        document.getElementById('playerScore').textContent = scores.player1;
        document.getElementById('opponentScore').textContent = scores.player2;
    } else {
        document.getElementById('playerScore').textContent = scores.player2;
        document.getElementById('opponentScore').textContent = scores.player1;
    }

    const resultRows = document.getElementById('resultRows');
    const moveEmojis = {
        'up': '⬆️',
        'down': '⬇️',
        'left': '⬅️',
        'right': '➡️',
        'none': '❌'
    };

    resultRows.innerHTML = results.map((result, index) => `
        <div class="result-row">
            <span>${index + 1}</span>
            <span>${moveEmojis[result.expected]}</span>
            <span>${moveEmojis[result.guessed]}</span>
            <span class="${result.correct ? 'result-correct' : 'result-incorrect'}">
                ${result.correct ? '✓' : '✗'}
            </span>
        </div>
    `).join('');

    document.getElementById('roundScore').textContent = `${correctMoves}/4 correct!`;
    document.getElementById('nextRoundText').textContent = 'Next round starting...';
});

socket.on('matchEnd', ({ scores, winner }) => {
    showGameSection('matchEndScreen');
    isTracking = false;

    let isWinner;
    if (playerRole === 'player1') {
        document.getElementById('finalPlayerScore').textContent = scores.player1;
        document.getElementById('finalOpponentScore').textContent = scores.player2;
        isWinner = winner === 'player1';
    } else {
        document.getElementById('finalPlayerScore').textContent = scores.player2;
        document.getElementById('finalOpponentScore').textContent = scores.player1;
        isWinner = winner === 'player2';
    }

    const resultTitle = document.getElementById('matchResultTitle');
    if (winner === 'tie') {
        resultTitle.textContent = "It's a Tie!";
        resultTitle.className = '';
    } else if (isWinner) {
        resultTitle.textContent = 'You Win! 🎉';
        resultTitle.className = 'winner';
    } else {
        resultTitle.textContent = 'You Lose 😢';
        resultTitle.className = 'loser';
    }

    document.getElementById('rematchBtn').disabled = false;
    document.getElementById('rematchStatus').classList.add('hidden');
});

socket.on('rematchProposed', ({ by }) => {
    showNotification('Opponent wants a rematch!');
});

socket.on('rematchStarting', () => {
    showNotification('Rematch starting!');
    currentCombination = [];
    detectedMoves = [];
    document.getElementById('playerScore').textContent = '0';
    document.getElementById('opponentScore').textContent = '0';
});

socket.on('opponentDisconnected', () => {
    showNotification('Opponent disconnected!');
    setTimeout(() => {
        location.reload();
    }, 2000);
});

// Initialize
console.log('Shadow Boxing Game initialized with center calibration');
