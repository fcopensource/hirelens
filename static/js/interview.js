const $ = (selector) => document.querySelector(selector);
const csrfToken = document.querySelector("[name=csrfmiddlewaretoken]")?.value || "";
const MEDIAPIPE_VERSION = "0.10.35";
const MEDIAPIPE_SOURCES = [
  {
    module: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/+esm`,
    wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  },
  {
    module: `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
    wasm: `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  },
];

const state = {
  interviewId: null,
  stream: null,
  peer: null,
  channel: null,
  remoteAudio: null,
  realtimeConnected: false,
  fallback: false,
  fallbackQuestion: "",
  startedAt: null,
  timer: null,
  voiceEnabled: true,
  micEnabled: true,
  cameraEnabled: true,
  captionsEnabled: true,
  candidateSpeaking: false,
  mayaSpeaking: false,
  candidateDraft: "",
  mayaDraft: "",
  suppressMayaTurn: false,
  activeVisionCue: false,
  eventCount: 0,
  turnCount: 0,
  completing: false,
  listenersBound: false,
  faceLandmarker: null,
  poseLandmarker: null,
  handLandmarker: null,
  visionRunning: false,
  lastFaceRun: 0,
  lastPoseRun: 0,
  lastHandRun: 0,
  lastClarityRun: 0,
  lastPosePoints: null,
  lastFaceResult: null,
  lastPoseResult: null,
  lastHandResult: null,
  poseHandsVisible: false,
  motionEma: 0,
  visionFrames: 0,
  visionFpsAt: 0,
  conditions: new Map(),
  cooldowns: new Map(),
  visionCueCooldown: 0,
  pendingVisionCue: null,
  visionCueTimer: null,
  coachingTimer: null,
  avatar: null,
  recognition: null,
  maxSeconds: Math.max(5, Number(document.body.dataset.maxMinutes || 25)) * 60,
  warnedTimeLimit: false,
};

const setupView = $("#setupView");
const interviewView = $("#interviewView");
const completeView = $("#completeView");
const preflightVideo = $("#preflightVideo");
const candidateVideo = $("#candidateVideo");

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}
window.addEventListener("load", refreshIcons);

async function api(url, options = {}) {
  const headers = { "X-CSRFToken": csrfToken, ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, { ...options, headers });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { error: "The server returned an unreadable response." };
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "Something went wrong. Please try again.");
  }
  return payload;
}

function toast(message, warning = false) {
  const node = document.createElement("div");
  node.className = `toast${warning ? " warning" : ""}`;
  node.innerHTML = `<i data-lucide="${warning ? "triangle-alert" : "check-circle-2"}"></i><span></span>`;
  node.querySelector("span").textContent = message;
  $("#toastStack").appendChild(node);
  refreshIcons();
  setTimeout(() => node.remove(), 4500);
}

function setDeviceStatus(device, ok, detail) {
  const row = document.querySelector(`[data-device="${device}"]`);
  if (!row) return;
  row.querySelector("small").textContent = detail;
  const icon = row.querySelector(".device-state");
  icon.outerHTML = `<i data-lucide="${ok ? "check-circle-2" : "circle-x"}" class="device-state ${ok ? "ok" : "bad"}"></i>`;
  refreshIcons();
}

async function checkDevices() {
  $("#setupError").textContent = "";
  const button = $("#checkDevices");
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader-circle"></i> Requesting access…';
  refreshIcons();
  try {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
        frameRate: { ideal: 24, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    preflightVideo.srcObject = state.stream;
    candidateVideo.srcObject = state.stream;
    $("#cameraPlaceholder").hidden = true;
    setDeviceStatus("camera", Boolean(state.stream.getVideoTracks().length), "Camera connected");
    setDeviceStatus("microphone", Boolean(state.stream.getAudioTracks().length), "Microphone connected");
    toast("Camera and microphone are ready.");
    return true;
  } catch {
    setDeviceStatus("camera", false, "Access denied or unavailable");
    setDeviceStatus("microphone", false, "Access denied or unavailable");
    $("#setupError").textContent = "Allow camera and microphone access in your browser, then try again.";
    return false;
  } finally {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="refresh-cw"></i> Check camera & microphone';
    refreshIcons();
  }
}

$("#checkDevices").addEventListener("click", checkDevices);

const resumeInput = $("#resumeFile");
const resumeDrop = $("#resumeDrop");
function showResume(file) {
  if (!file) {
    $("#resumeTitle").textContent = "Add your resume";
    $("#resumeHint").textContent = "PDF, DOCX or TXT · up to 5 MB";
    return;
  }
  $("#resumeTitle").textContent = file.name;
  $("#resumeHint").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ready to use`;
}
resumeInput.addEventListener("change", () => showResume(resumeInput.files[0]));
["dragenter", "dragover"].forEach((name) => resumeDrop.addEventListener(name, (event) => {
  event.preventDefault();
  resumeDrop.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => resumeDrop.addEventListener(name, (event) => {
  event.preventDefault();
  resumeDrop.classList.remove("dragging");
}));
resumeDrop.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  resumeInput.files = transfer.files;
  showResume(file);
});

$("#setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#setupError");
  error.textContent = "";
  const name = $("#candidateName").value.trim();
  const role = $("#targetRole").value.trim();
  if (!name || !role) {
    error.textContent = "Enter your name and the role before continuing.";
    return;
  }
  if (!$("#consent").checked) {
    error.textContent = "Please review and accept the camera and microphone consent.";
    return;
  }
  if (!state.stream?.active && !(await checkDevices())) return;

  const button = $("#startButton");
  button.disabled = true;
  button.querySelector("span").textContent = "Maya is joining…";
  try {
    const form = new FormData(event.currentTarget);
    form.set("consent", "true");
    form.set("realtime", "true");
    const payload = await api("/api/interviews/start/", { method: "POST", body: form });
    state.interviewId = payload.interview_id;
    state.fallbackQuestion = payload.question;
    state.startedAt = Date.now();
    $("#roleLabel").textContent = role;
    $("#candidateLabel").textContent = name;
    $("#candidateInitial").textContent = (name[0] || "Y").toUpperCase();
    $("#completeName").textContent = name.split(/\s+/)[0];
    $("#sessionModeLabel").textContent = $("#sessionMode").value === "practice" ? "Practice & learn" : "Interview";
    setupView.hidden = true;
    interviewView.hidden = false;
    candidateVideo.srcObject = state.stream;
    candidateVideo.play().catch(() => {});
    startSessionTimer();
    bindIntegrityListeners();
    initAvatar();
    initVision();
    await connectRealtime(payload);
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Join live interview";
  }
});

function startSessionTimer() {
  clearInterval(state.timer);
  const tick = () => {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    $("#sessionTimer").textContent = formatDuration(elapsed);
    if (!state.warnedTimeLimit && elapsed >= state.maxSeconds - 120) {
      state.warnedTimeLimit = true;
      toast("Two minutes remain in this session.", true);
    }
    if (elapsed >= state.maxSeconds && !state.completing) {
      toast("The session time limit was reached. Preparing your recap.");
      completeInterview();
    }
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setConnection(label, mode = "") {
  const badge = $("#connectionBadge");
  badge.className = `connection-pill ${mode}`;
  badge.innerHTML = `<span></span>${label}`;
}

async function connectRealtime(payload) {
  if (!payload.realtime_available || !window.RTCPeerConnection) {
    activateFallback(payload.question, "Live voice is not configured; text and browser voice are active.");
    return;
  }
  try {
    const peer = new RTCPeerConnection();
    state.peer = peer;
    state.remoteAudio = document.createElement("audio");
    state.remoteAudio.autoplay = true;
    peer.ontrack = (event) => {
      state.remoteAudio.srcObject = event.streams[0];
      state.remoteAudio.muted = !state.voiceEnabled;
      state.remoteAudio.play().catch(() => {});
    };
    state.stream.getAudioTracks().forEach((track) => peer.addTrack(track, state.stream));
    const channel = peer.createDataChannel("oai-events");
    state.channel = channel;
    channel.addEventListener("message", (event) => {
      try { handleRealtimeEvent(JSON.parse(event.data)); } catch { /* Ignore malformed events. */ }
    });
    channel.addEventListener("open", () => {
      state.realtimeConnected = true;
      setConnection("Live voice connected", "connected");
      $("#speakingState").innerHTML = '<i data-lucide="ear"></i> Listening';
      refreshIcons();
      sendEvent({
        type: "response.create",
        response: {
          instructions: "Greet the candidate warmly in one short sentence, mention that this is a live conversation, then ask the first relevant interview question.",
        },
      });
    });
    channel.addEventListener("close", () => {
      if (!state.completing && !state.fallback) activateFallback(state.fallbackQuestion, "The live connection ended. Text fallback is ready.");
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" && !state.fallback) {
        activateFallback(state.fallbackQuestion, "Live voice lost connection. Text fallback is ready.");
      }
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(`/api/interviews/${state.interviewId}/realtime/`, {
      method: "POST",
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp", "X-CSRFToken": csrfToken },
    });
    if (!response.ok) {
      let message = "Live voice could not start.";
      try { message = (await response.json()).error || message; } catch { /* SDP errors may be text. */ }
      throw new Error(message);
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    state.peer?.close();
    state.peer = null;
    activateFallback(payload.question, `${error.message} Text fallback is ready.`);
  }
}

function sendEvent(event) {
  if (state.channel?.readyState !== "open") return false;
  state.channel.send(JSON.stringify(event));
  return true;
}

function handleRealtimeEvent(event) {
  const type = event.type || "";
  if (type === "input_audio_buffer.speech_started") {
    state.candidateSpeaking = true;
    state.candidateDraft = "";
    $("#speakingState").innerHTML = '<i data-lucide="ear"></i> Listening';
    refreshIcons();
  }
  if (type === "input_audio_buffer.speech_stopped") {
    state.candidateSpeaking = false;
    setTimeout(flushVisionCue, 500);
  }

  if (type === "conversation.item.input_audio_transcription.delta") {
    state.candidateDraft += event.delta || "";
    showCaption("candidate", state.candidateDraft);
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = (event.transcript || state.candidateDraft).trim();
    state.candidateDraft = "";
    if (text) commitTurn("candidate", text);
  }

  if (type === "response.created" || type === "response.output_audio.delta") setMayaSpeaking(true);
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    state.mayaDraft += event.delta || "";
    showCaption("maya", state.mayaDraft);
    setMayaSpeaking(true);
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    const text = (event.transcript || state.mayaDraft).trim();
    state.mayaDraft = "";
    if (text && !state.suppressMayaTurn) commitTurn("interviewer", text);
    state.suppressMayaTurn = false;
    state.activeVisionCue = false;
  }
  if (type === "response.done") {
    setMayaSpeaking(false);
    state.activeVisionCue = false;
    if (!state.mayaDraft) setTimeout(() => {
      if (!state.mayaSpeaking) $("#mayaCaption").textContent = "I’m listening.";
    }, 1800);
    setTimeout(flushVisionCue, 650);
  }
  if (type === "error") {
    toast(event.error?.message || "Maya had trouble responding. Please try again.", true);
  }
}

function setMayaSpeaking(speaking) {
  state.mayaSpeaking = speaking;
  $("#mayaGlow").classList.toggle("active", speaking);
  $("#speakingState").innerHTML = speaking
    ? '<i data-lucide="audio-lines"></i> Speaking'
    : '<i data-lucide="ear"></i> Listening';
  refreshIcons();
}

function showCaption(speaker, text) {
  const element = speaker === "maya" ? $("#mayaCaption") : $("#candidateCaption");
  element.textContent = text;
  element.hidden = !state.captionsEnabled || !text;
}

function appendTurn(speaker, text) {
  const feed = $("#conversationFeed");
  feed.querySelector(".empty-feed")?.remove();
  const item = document.createElement("div");
  item.className = `turn ${speaker}`;
  item.innerHTML = `<span>${speaker === "candidate" ? "YOU" : "MAYA"}</span><p></p>`;
  item.querySelector("p").textContent = text;
  feed.appendChild(item);
  feed.scrollTop = feed.scrollHeight;
  state.turnCount += 1;
}

function commitTurn(speaker, text) {
  appendTurn(speaker, text);
  api(`/api/interviews/${state.interviewId}/transcript/`, {
    method: "POST",
    body: JSON.stringify({ speaker, text }),
  }).catch(() => toast("A transcript turn could not be saved.", true));
}

function sendRealtimeText(text, vision = false) {
  const clean = text.trim();
  if (!clean || !state.realtimeConnected) return false;
  if (!vision) {
    appendTurn("candidate", clean);
    api(`/api/interviews/${state.interviewId}/transcript/`, {
      method: "POST",
      body: JSON.stringify({ speaker: "candidate", text: clean }),
    }).catch(() => {});
  } else {
    state.suppressMayaTurn = true;
    state.activeVisionCue = true;
  }
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: vision
          ? `[VISUAL SETUP NOTE — PRIVATE, NON-EVALUATIVE: ${clean}. Briefly and kindly ask the candidate to correct it, then continue the interview.]`
          : clean,
      }],
    },
  });
  sendEvent({ type: "response.create" });
  return true;
}

function activateFallback(question, reason) {
  if (state.fallback) return;
  state.fallback = true;
  state.realtimeConnected = false;
  setConnection("Text fallback", "fallback");
  $("#fallbackComposer").hidden = false;
  $("#fallbackQuestion").textContent = question || "Tell me about your experience.";
  $("#mayaCaption").textContent = question || "Tell me about your experience.";
  commitTurn("interviewer", question || "Tell me about your experience.");
  toast(reason, true);
  speakLocally(question);
}

function speakLocally(text) {
  if (!text || !state.voiceEnabled || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const language = $("#responseLanguage").value;
  if (language === "hindi") utterance.lang = "hi-IN";
  utterance.rate = 1.03;
  utterance.onstart = () => setMayaSpeaking(true);
  utterance.onend = () => setMayaSpeaking(false);
  speechSynthesis.speak(utterance);
}

$("#fallbackSend").addEventListener("click", async () => {
  const answer = $("#fallbackText").value.trim();
  if (answer.length < 8) {
    toast("Give Maya a fuller answer first.", true);
    return;
  }
  const button = $("#fallbackSend");
  button.disabled = true;
  appendTurn("candidate", answer);
  try {
    const payload = await api(`/api/interviews/${state.interviewId}/answer/`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    $("#fallbackText").value = "";
    if (payload.complete) {
      toast("You completed the planned questions. End when you are ready.");
      return;
    }
    state.fallbackQuestion = payload.question;
    $("#fallbackQuestion").textContent = payload.question;
    $("#mayaCaption").textContent = payload.question;
    appendTurn("interviewer", payload.question);
    speakLocally(payload.question);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#textSend").addEventListener("click", sendTextComposer);
$("#textMessage").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendTextComposer();
  }
});
function sendTextComposer() {
  const input = $("#textMessage");
  const text = input.value.trim();
  if (!text) return;
  if (state.realtimeConnected) {
    sendRealtimeText(text);
  } else {
    $("#fallbackText").value = text;
    $("#fallbackSend").click();
  }
  input.value = "";
  $("#textComposer").hidden = true;
  $("#textControl").classList.remove("active");
}

$("#transcriptToggle").addEventListener("click", () => $("#transcriptDrawer").classList.toggle("open"));
$("#transcriptClose").addEventListener("click", () => $("#transcriptDrawer").classList.remove("open"));
$("#textControl").addEventListener("click", () => {
  const composer = $("#textComposer");
  composer.hidden = !composer.hidden;
  $("#textControl").classList.toggle("active", !composer.hidden);
  if (!composer.hidden) $("#textMessage").focus();
});
$("#captionControl").addEventListener("click", () => {
  state.captionsEnabled = !state.captionsEnabled;
  $("#captionControl").classList.toggle("off", !state.captionsEnabled);
  $("#mayaCaption").hidden = !state.captionsEnabled;
  $("#candidateCaption").hidden = !state.captionsEnabled || !$("#candidateCaption").textContent;
});
$("#micControl").addEventListener("click", () => {
  state.micEnabled = !state.micEnabled;
  state.stream?.getAudioTracks().forEach((track) => { track.enabled = state.micEnabled; });
  $("#micControl").classList.toggle("off", !state.micEnabled);
  $("#micControl").querySelector("small").textContent = state.micEnabled ? "Mute" : "Unmute";
  $("#micControl").querySelector("span").innerHTML = `<i data-lucide="${state.micEnabled ? "mic" : "mic-off"}"></i>`;
  refreshIcons();
});
$("#cameraControl").addEventListener("click", () => {
  state.cameraEnabled = !state.cameraEnabled;
  state.stream?.getVideoTracks().forEach((track) => { track.enabled = state.cameraEnabled; });
  $("#cameraControl").classList.toggle("off", !state.cameraEnabled);
  $("#cameraOffMessage").classList.toggle("visible", !state.cameraEnabled);
  $("#cameraControl").querySelector("span").innerHTML = `<i data-lucide="${state.cameraEnabled ? "video" : "video-off"}"></i>`;
  refreshIcons();
});
$("#soundToggle").addEventListener("click", () => {
  state.voiceEnabled = !state.voiceEnabled;
  if (state.remoteAudio) state.remoteAudio.muted = !state.voiceEnabled;
  if (!state.voiceEnabled && "speechSynthesis" in window) speechSynthesis.cancel();
  $("#soundToggle").innerHTML = `<i data-lucide="${state.voiceEnabled ? "volume-2" : "volume-x"}"></i>`;
  refreshIcons();
});

function bindIntegrityListeners() {
  if (state.listenersBound) return;
  state.listenersBound = true;
  document.addEventListener("visibilitychange", () => {
    if (interviewView.hidden || !document.hidden) return;
    recordIntegrity("tab_hidden", { reason: "tab_hidden" });
    toast("Return to the interview tab when you can.", true);
  });
  window.addEventListener("blur", () => {
    if (!interviewView.hidden) recordIntegrity("window_blur", { reason: "window_blur" });
  });
  document.addEventListener("fullscreenchange", () => {
    if (!interviewView.hidden && !document.fullscreenElement) {
      recordIntegrity("fullscreen_exit", { reason: "fullscreen_closed" });
    }
  });
}

async function recordIntegrity(kind, details = {}, durationMs = 0) {
  if (!state.interviewId || state.completing) return;
  const last = state.cooldowns.get(`event:${kind}`) || 0;
  if (Date.now() - last < 12000) return;
  state.cooldowns.set(`event:${kind}`, Date.now());
  state.eventCount += 1;
  $("#eventCount").textContent = state.eventCount;
  try {
    await api(`/api/interviews/${state.interviewId}/event/`, {
      method: "POST",
      body: JSON.stringify({
        kind,
        details,
        duration_ms: durationMs,
        occurred_at: new Date().toISOString(),
      }),
    });
  } catch { /* Monitoring must never stop the interview. */ }
}

function showCoaching(message, speak = true) {
  const banner = $("#coachingBanner");
  banner.querySelector("span").textContent = message;
  banner.hidden = false;
  clearTimeout(state.coachingTimer);
  state.coachingTimer = setTimeout(() => { banner.hidden = true; }, 6500);
  if (!speak) return;
  state.pendingVisionCue = { message, queuedAt: Date.now() };
  flushVisionCue();
}

function flushVisionCue() {
  clearTimeout(state.visionCueTimer);
  state.visionCueTimer = null;
  const cue = state.pendingVisionCue;
  if (!cue || !state.realtimeConnected || state.activeVisionCue) return;
  if (Date.now() - cue.queuedAt > 18000) {
    state.pendingVisionCue = null;
    return;
  }
  if (state.candidateSpeaking || state.mayaSpeaking) return;
  const wait = state.visionCueCooldown - Date.now();
  if (wait > 0) {
    state.visionCueTimer = setTimeout(flushVisionCue, Math.min(wait + 100, 18000));
    return;
  }
  state.pendingVisionCue = null;
  state.visionCueCooldown = Date.now() + 30000;
  sendRealtimeText(cue.message, true);
}

function sustainedCondition(kind, bad, seconds, message, details = {}, speak = true) {
  if (!bad) {
    state.conditions.delete(kind);
    return;
  }
  const started = state.conditions.get(kind) || Date.now();
  state.conditions.set(kind, started);
  if (Date.now() - started < seconds * 1000) return;
  const last = state.cooldowns.get(`condition:${kind}`) || 0;
  if (Date.now() - last < 30000) return;
  state.cooldowns.set(`condition:${kind}`, Date.now());
  recordIntegrity(kind, details, Date.now() - started);
  showCoaching(message, speak);
}

async function loadVisionRuntime() {
  let lastError = null;
  for (const source of MEDIAPIPE_SOURCES) {
    try {
      const vision = await import(source.module);
      const files = await vision.FilesetResolver.forVisionTasks(source.wasm);
      return { vision, files };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Local vision runtime could not be downloaded.");
}

async function initVision() {
  $("#visionStatus").innerHTML = '<i data-lucide="loader-circle"></i> Loading face, eyes, pose & hands';
  refreshIcons();
  try {
    const { vision, files } = await loadVisionRuntime();
    const delegateOptions = async (Ctor, modelAssetPath, extras = {}) => {
      try {
        return await Ctor.createFromOptions(files, {
          baseOptions: { modelAssetPath, delegate: "GPU" },
          runningMode: "VIDEO",
          ...extras,
        });
      } catch {
        return Ctor.createFromOptions(files, {
          baseOptions: { modelAssetPath, delegate: "CPU" },
          runningMode: "VIDEO",
          ...extras,
        });
      }
    };
    const models = [
      {
        key: "faceLandmarker",
        label: "face + eyes",
        ctor: vision.FaceLandmarker,
        path: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        options: {
          numFaces: 2,
          minFaceDetectionConfidence: .5,
          minFacePresenceConfidence: .5,
          minTrackingConfidence: .5,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        },
      },
      {
        key: "poseLandmarker",
        label: "posture",
        ctor: vision.PoseLandmarker,
        path: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        options: { numPoses: 1, minPoseDetectionConfidence: .5, minTrackingConfidence: .5 },
      },
      {
        key: "handLandmarker",
        label: "hands",
        ctor: vision.HandLandmarker,
        path: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        options: {
          numHands: 2,
          minHandDetectionConfidence: .45,
          minHandPresenceConfidence: .45,
          minTrackingConfidence: .45,
        },
      },
    ];
    const failed = [];
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      $("#visionStatus").innerHTML = `<i data-lucide="loader-circle"></i> Loading ${model.label}`;
      refreshIcons();
      try {
        state[model.key] = await delegateOptions(model.ctor, model.path, model.options);
        if (!state.visionRunning) {
          state.visionRunning = true;
          state.visionFpsAt = performance.now();
          requestAnimationFrame(visionLoop);
        }
      } catch (error) {
        failed.push(model.label);
        console.warn(`[HireLens vision] ${model.label} failed to initialize.`, error?.message || error);
      }
      const active = models.slice(0, index + 1).filter((item) => state[item.key]).map((item) => item.label);
      const remaining = models.slice(index + 1).map((item) => item.label);
      $("#visionStatus").innerHTML = remaining.length
        ? `<i data-lucide="loader-circle"></i> ${active.length ? `${active.join(" · ")} active · ` : ""}loading ${remaining[0]}`
        : `<i data-lucide="${active.length ? "shield-check" : "circle-alert"}"></i> ${active.length ? `Local ${active.join(" · ")} active` : "Camera active · advanced landmarks unavailable"}`;
      refreshIcons();
    }
    if (failed.length) {
      recordIntegrity("vision_unavailable", { reason: failed.join(",") });
      showCoaching(`Some local tracking is unavailable: ${failed.join(", ")}. Camera clarity checks will continue.`, false);
    }
    if (!state.visionRunning) requestAnimationFrame(clarityOnlyLoop);
  } catch (error) {
    console.warn("[HireLens vision] runtime failed to initialize.", error?.message || error);
    $("#visionStatus").innerHTML = '<i data-lucide="circle-alert"></i> Camera active · advanced landmarks unavailable';
    $("#faceChip").classList.add("warn");
    $("#postureChip").classList.add("warn");
    $("#handsChip").classList.add("warn");
    setHudStatus("eyeStatus", "unavailable", "warn");
    setHudStatus("postureStatus", "unavailable", "warn");
    setHudStatus("handStatus", "unavailable", "warn");
    setHudStatus("trackingFps", "clarity only", "warn");
    recordIntegrity("vision_unavailable", { reason: "runtime_download_failed" });
    showCoaching("Local movement tracking could not start. Check your connection and reload before continuing.", false);
    refreshIcons();
    requestAnimationFrame(clarityOnlyLoop);
  }
}

function setHudStatus(id, text, tone = "") {
  const element = $(`#${id}`);
  if (!element) return;
  element.textContent = text;
  element.className = tone;
}

function prepareLandmarkCanvas() {
  const canvas = $("#landmarkCanvas");
  const width = candidateVideo.videoWidth || candidateVideo.clientWidth;
  const height = candidateVideo.videoHeight || candidateVideo.clientHeight;
  if (!width || !height) return null;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  return { canvas, context, width, height };
}

function visionLoop(timestamp) {
  if (!state.visionRunning || interviewView.hidden || !state.cameraEnabled) {
    if (state.visionRunning && !state.completing) requestAnimationFrame(visionLoop);
    return;
  }
  const drawing = prepareLandmarkCanvas();
  if (!drawing || candidateVideo.readyState < 2) {
    requestAnimationFrame(visionLoop);
    return;
  }
  let inferenceRan = false;
  if (state.faceLandmarker && timestamp - state.lastFaceRun > 170) {
    state.lastFaceRun = timestamp;
    try {
      state.lastFaceResult = state.faceLandmarker.detectForVideo(candidateVideo, timestamp);
      handleFace(state.lastFaceResult);
      inferenceRan = true;
    } catch { /* next frame */ }
  }
  if (state.poseLandmarker && timestamp - state.lastPoseRun > 280) {
    state.lastPoseRun = timestamp;
    try {
      state.lastPoseResult = state.poseLandmarker.detectForVideo(candidateVideo, timestamp);
      handlePose(state.lastPoseResult);
      inferenceRan = true;
    } catch { /* next frame */ }
  }
  if (state.handLandmarker && timestamp - state.lastHandRun > 220) {
    state.lastHandRun = timestamp;
    try {
      state.lastHandResult = state.handLandmarker.detectForVideo(candidateVideo, timestamp);
      handleHands(state.lastHandResult);
      inferenceRan = true;
    } catch { /* next frame */ }
  }
  if (timestamp - state.lastClarityRun > 1800) {
    state.lastClarityRun = timestamp;
    analyzeClarity();
  }
  drawTrackingOverlay(drawing);
  if (inferenceRan) state.visionFrames += 1;
  if (timestamp - state.visionFpsAt >= 1000) {
    const fps = Math.round(state.visionFrames * 1000 / (timestamp - state.visionFpsAt));
    setHudStatus("trackingFps", `${fps} fps`, "ok");
    state.visionFrames = 0;
    state.visionFpsAt = timestamp;
  }
  requestAnimationFrame(visionLoop);
}

function clarityOnlyLoop(timestamp) {
  if (interviewView.hidden || state.completing) return;
  if (state.cameraEnabled && timestamp - state.lastClarityRun > 1800) {
    state.lastClarityRun = timestamp;
    analyzeClarity();
  }
  requestAnimationFrame(clarityOnlyLoop);
}

function dot(context, point, width, height, color = "rgba(99,239,178,.7)", radius = 2) {
  context.beginPath();
  context.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function line(context, a, b, width, height, color, size = 1.4) {
  if (!a || !b) return;
  context.beginPath();
  context.moveTo(a.x * width, a.y * height);
  context.lineTo(b.x * width, b.y * height);
  context.strokeStyle = color;
  context.lineWidth = size;
  context.stroke();
}

function drawTrackingOverlay(drawing) {
  const { context, width, height } = drawing;
  const face = state.lastFaceResult?.faceLandmarks?.[0];
  if (face) {
    const eyeLoops = [
      [33, 160, 158, 133, 153, 144, 33],
      [362, 385, 387, 263, 373, 380, 362],
    ];
    eyeLoops.forEach((loop) => {
      for (let index = 1; index < loop.length; index += 1) {
        line(context, face[loop[index - 1]], face[loop[index]], width, height, "rgba(99,239,178,.8)", 1.6);
      }
    });
    [468, 469, 470, 471, 472, 473, 474, 475, 476, 477, 1, 10, 152].forEach((index) => {
      if (face[index]) dot(context, face[index], width, height, "rgba(173,255,212,.9)", index >= 468 ? 1.8 : 2.2);
    });
  }
  const pose = state.lastPoseResult?.landmarks?.[0];
  if (pose) {
    const poseConnections = [
      [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
      [11, 23], [12, 24], [23, 24],
    ];
    poseConnections.forEach(([a, b]) => line(context, pose[a], pose[b], width, height, "rgba(213,248,113,.72)", 2.1));
    [0, 11, 12, 13, 14, 15, 16, 23, 24].forEach((index) => {
      if (pose[index]) dot(context, pose[index], width, height, "rgba(213,248,113,.9)", 3);
    });
  }
  const handConnections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  (state.lastHandResult?.landmarks || []).forEach((hand) => {
    handConnections.forEach(([a, b]) => line(context, hand[a], hand[b], width, height, "rgba(109,205,255,.8)", 1.7));
    hand.forEach((point) => dot(context, point, width, height, "rgba(145,220,255,.95)", 2));
  });
}

function blendshapeScore(result, name) {
  const category = result.faceBlendshapes?.[0]?.categories?.find((item) => item.categoryName === name);
  return category?.score || 0;
}

function handleFace(result) {
  const faces = result.faceLandmarks || [];
  const faceOk = faces.length === 1;
  $("#faceChip").classList.toggle("ok", faceOk);
  $("#faceChip").classList.toggle("warn", !faceOk);
  sustainedCondition(
    faces.length ? "multiple_faces" : "face_missing",
    faces.length !== 1,
    faces.length > 1 ? 2.5 : 4,
    faces.length > 1 ? "Please keep only one person in the camera frame." : "I can’t see you clearly—please move back into the frame.",
    { face_count: faces.length }
  );
  if (!faces.length) {
    setHudStatus("eyeStatus", "not visible", "warn");
    return;
  }
  const points = faces[0];
  const nose = points[1];
  const faceLeft = points[33];
  const faceRight = points[263];
  const chin = points[152];
  const eyeLineY = ((points[33]?.y || 0) + (points[263]?.y || 0)) / 2;
  const irisCenter = (indexes) => {
    const found = indexes.map((index) => points[index]).filter(Boolean);
    if (!found.length) return null;
    return found.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  };
  const leftIrisSum = irisCenter([468, 469, 470, 471, 472]);
  const rightIrisSum = irisCenter([473, 474, 475, 476, 477]);
  const normalizeIris = (sum, count, cornerA, cornerB) => {
    if (!sum || !cornerA || !cornerB) return .5;
    const centerX = sum.x / count;
    const min = Math.min(cornerA.x, cornerB.x);
    const max = Math.max(cornerA.x, cornerB.x);
    return (centerX - min) / Math.max(max - min, .001);
  };
  const leftGaze = normalizeIris(leftIrisSum, 5, points[33], points[133]);
  const rightGaze = normalizeIris(rightIrisSum, 5, points[362], points[263]);
  const blink = Math.max(blendshapeScore(result, "eyeBlinkLeft"), blendshapeScore(result, "eyeBlinkRight")) > .58;
  const faceCenter = faceLeft && faceRight ? (faceLeft.x + faceRight.x) / 2 : .5;
  const faceWidth = faceLeft && faceRight ? Math.abs(faceRight.x - faceLeft.x) : .1;
  const yawRatio = nose ? (nose.x - faceCenter) / Math.max(faceWidth, .01) : 0;
  const pitchRatio = nose && chin ? (nose.y - eyeLineY) / Math.max(chin.y - eyeLineY, .01) : .45;
  const lookingSide = leftGaze < .17 || leftGaze > .83 || rightGaze < .17 || rightGaze > .83;
  const headTurned = Math.abs(yawRatio) > .24 || pitchRatio < .28 || pitchRatio > .68;
  const attentionOff = !blink && (lookingSide || headTurned);
  let eyeLabel = "camera aligned";
  if (blink) eyeLabel = "blink";
  else if (yawRatio > .24) eyeLabel = "turned left";
  else if (yawRatio < -.24) eyeLabel = "turned right";
  else if (pitchRatio < .28) eyeLabel = "looking up";
  else if (pitchRatio > .68) eyeLabel = "looking down";
  else if (lookingSide) eyeLabel = "looking aside";
  setHudStatus("eyeStatus", eyeLabel, attentionOff ? "warn" : "ok");
  sustainedCondition(
    "gaze_away",
    attentionOff,
    4.5,
    "Please bring your face and eyes back toward the camera so I can see you clearly.",
    { reason: headTurned ? "head_orientation" : "eye_direction" },
    true
  );
}

function handlePose(result) {
  const poses = result.landmarks || [];
  if (!poses.length) {
    $("#postureChip").classList.remove("ok");
    $("#postureChip").classList.add("warn");
    $("#bodyFrame").classList.remove("ok");
    setHudStatus("postureStatus", "not visible", "warn");
    sustainedCondition("body_not_framed", true, 6, "Please step back a little so I can see your shoulders and upper body.");
    return;
  }
  const pose = poses[0];
  const needed = [0, 11, 12, 13, 14, 15, 16, 23, 24];
  const visible = (index) => {
    const point = pose[index];
    return point && (point.visibility ?? 1) > .45 && point.x > .02 && point.x < .98 && point.y > .02 && point.y < .99;
  };
  const shoulders = visible(11) && visible(12);
  const elbows = visible(13) && visible(14);
  state.poseHandsVisible = visible(15) && visible(16);
  const bodyOk = shoulders && elbows;
  const shoulderTilt = shoulders ? Math.abs(Math.atan2(pose[12].y - pose[11].y, pose[12].x - pose[11].x) * 180 / Math.PI) : 90;
  const centerX = shoulders ? (pose[11].x + pose[12].x) / 2 : .5;
  const centered = centerX > .27 && centerX < .73;
  const postureOk = bodyOk && shoulderTilt < 12 && centered;
  $("#bodyFrame").classList.toggle("ok", bodyOk);
  $("#postureChip").classList.toggle("ok", postureOk);
  $("#postureChip").classList.toggle("warn", !postureOk);
  setHudStatus(
    "postureStatus",
    !bodyOk ? "step back" : !centered ? "move to center" : shoulderTilt >= 12 ? "level shoulders" : "centered",
    postureOk ? "ok" : "warn"
  );
  sustainedCondition(
    "body_not_framed",
    !postureOk,
    7,
    !bodyOk
      ? "Please step back slightly so your upper body is inside the frame."
      : !centered
        ? "Please move a little toward the center of the camera."
        : "Please level the camera or relax your shoulders into the frame.",
    { reason: !bodyOk ? "upper_body_missing" : !centered ? "off_center" : "shoulder_tilt" }
  );

  const current = needed.map((index) => pose[index]).filter(Boolean);
  if (state.lastPosePoints?.length === current.length) {
    const movement = current.reduce((sum, point, index) => {
      const before = state.lastPosePoints[index];
      return sum + Math.hypot(point.x - before.x, point.y - before.y);
    }, 0) / current.length;
    state.motionEma = state.motionEma * .78 + movement * .22;
    const movementLabel = state.motionEma > .035 ? "high" : state.motionEma > .009 ? "natural" : "steady";
    $("#motionValue").textContent = movementLabel;
    sustainedCondition(
      "excessive_motion",
      state.motionEma > .05,
      5,
      "There is a lot of movement in the frame—please steady the camera and settle comfortably.",
      { reason: "landmark_motion" }
    );
  }
  state.lastPosePoints = current.map((point) => ({ x: point.x, y: point.y }));
  if (!state.handLandmarker) {
    const handsOk = bodyOk && state.poseHandsVisible;
    $("#handsChip").classList.toggle("ok", handsOk);
    $("#handsChip").classList.toggle("warn", !handsOk);
    setHudStatus("handStatus", handsOk ? "wrists visible" : "outside frame", handsOk ? "ok" : "warn");
    sustainedCondition("hands_not_visible", bodyOk && !handsOk, 9, "Please adjust the camera so both hands are visible when possible.");
  }
}

function handleHands(result) {
  const hands = result.landmarks || [];
  const count = Math.min(hands.length, 2);
  const handsOk = count === 2;
  $("#handsChip").classList.toggle("ok", handsOk);
  $("#handsChip").classList.toggle("warn", !handsOk);
  setHudStatus("handStatus", `${count}/2 visible`, handsOk ? "ok" : "warn");
  sustainedCondition(
    "hands_not_visible",
    Boolean(state.lastPoseResult?.landmarks?.length) && count < 2,
    9,
    count === 0
      ? "Please move back or lower the camera slightly so both hands are visible."
      : "I can see one hand—please bring the other hand into the frame when possible.",
    { reason: count === 0 ? "no_hands" : "one_hand" }
  );
}

function analyzeClarity() {
  if (candidateVideo.readyState < 2) return;
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 60;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(candidateVideo, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Float32Array(canvas.width * canvas.height);
  let light = 0;
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    gray[p] = pixels[i] * .299 + pixels[i + 1] * .587 + pixels[i + 2] * .114;
    light += gray[p];
  }
  light /= gray.length;
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < canvas.height - 1; y += 1) {
    for (let x = 1; x < canvas.width - 1; x += 1) {
      const i = y * canvas.width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - canvas.width] - gray[i + canvas.width];
      lapSum += lap;
      lapSq += lap * lap;
      count += 1;
    }
  }
  const variance = lapSq / count - (lapSum / count) ** 2;
  const lowLight = light < 42;
  const blurry = !lowLight && variance < 85;
  const clear = !lowLight && !blurry;
  $("#clarityChip").classList.toggle("ok", clear);
  $("#clarityChip").classList.toggle("warn", !clear);
  sustainedCondition("low_light", lowLight, 6, "The room looks dark—please add a little light in front of you.");
  sustainedCondition("camera_blurry", blurry, 7, "Your camera looks blurry. Please clean the lens or move into better focus.");
}

async function initAvatar() {
  try {
    const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js");
    const canvas = $("#avatarCanvas");
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07120d, .035);
    const camera = new THREE.PerspectiveCamera(31, 1, .1, 100);
    camera.position.set(0, .25, 7.6);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    const avatar = new THREE.Group();
    avatar.position.y = -.15;
    scene.add(avatar);
    const headGroup = new THREE.Group();
    avatar.add(headGroup);

    const skin = new THREE.MeshPhysicalMaterial({
      color: 0xb9785b,
      roughness: .58,
      clearcoat: .08,
      clearcoatRoughness: .7,
    });
    const skinWarm = new THREE.MeshStandardMaterial({ color: 0x9e5f4e, roughness: .72 });
    const hairMaterial = new THREE.MeshStandardMaterial({ color: 0x171715, roughness: .88 });
    const blazer = new THREE.MeshPhysicalMaterial({ color: 0x123f31, roughness: .68, clearcoat: .12 });
    const blazerDark = new THREE.MeshStandardMaterial({ color: 0x09271d, roughness: .78 });
    const blouse = new THREE.MeshStandardMaterial({ color: 0xe4eee7, roughness: .8 });
    const sclera = new THREE.MeshPhysicalMaterial({ color: 0xf5f2e9, roughness: .3, clearcoat: .25 });
    const irisMaterial = new THREE.MeshPhysicalMaterial({ color: 0x315746, roughness: .25, clearcoat: .5 });
    const pupilMaterial = new THREE.MeshStandardMaterial({ color: 0x090d0b, roughness: .2 });
    const lipMaterial = new THREE.MeshPhysicalMaterial({ color: 0x7b3f43, roughness: .5, clearcoat: .16 });
    const mouthInnerMaterial = new THREE.MeshStandardMaterial({ color: 0x321c20, roughness: 1 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb6d8c8, metalness: .55, roughness: .35 });

    const makeMesh = (geometry, material, position, scale, parent = avatar) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      parent.add(mesh);
      return mesh;
    };

    const neck = makeMesh(new THREE.CylinderGeometry(.34, .42, .85, 32), skin, [0, -.15, 0], [1, 1, .9]);
    neck.rotation.x = -.03;
    const torso = makeMesh(new THREE.CapsuleGeometry(1.18, 1.35, 10, 36), blazer, [0, -1.55, -.08], [1.42, 1.02, .58]);
    const blousePanel = makeMesh(new THREE.ConeGeometry(.66, 1.55, 3), blouse, [0, -1.12, .7], [1, 1, .3]);
    blousePanel.rotation.z = Math.PI;
    const lapelLeft = makeMesh(new THREE.ConeGeometry(.42, 1.35, 3), blazerDark, [-.42, -1.15, .68], [.75, 1, .2]);
    lapelLeft.rotation.z = Math.PI + .22;
    const lapelRight = makeMesh(new THREE.ConeGeometry(.42, 1.35, 3), blazerDark, [.42, -1.15, .68], [.75, 1, .2]);
    lapelRight.rotation.z = Math.PI - .22;
    makeMesh(new THREE.SphereGeometry(.075, 18, 14), metal, [0, -1.55, .79], [1, 1, .45]);

    const leftArm = makeMesh(new THREE.CapsuleGeometry(.25, 1.25, 8, 22), blazer, [-1.46, -1.48, -.05], [1, 1, .85]);
    const rightArm = makeMesh(new THREE.CapsuleGeometry(.25, 1.25, 8, 22), blazer, [1.46, -1.48, -.05], [1, 1, .85]);
    leftArm.rotation.z = -.12;
    rightArm.rotation.z = .12;

    const head = makeMesh(new THREE.SphereGeometry(1.13, 56, 44), skin, [0, .92, 0], [.82, 1.06, .78], headGroup);
    makeMesh(new THREE.SphereGeometry(.24, 28, 20), skin, [-.87, .93, -.02], [.48, .78, .38], headGroup);
    makeMesh(new THREE.SphereGeometry(.24, 28, 20), skin, [.87, .93, -.02], [.48, .78, .38], headGroup);
    makeMesh(new THREE.SphereGeometry(.1, 18, 14), skinWarm, [-.91, .93, .05], [.35, .7, .22], headGroup);
    makeMesh(new THREE.SphereGeometry(.1, 18, 14), skinWarm, [.91, .93, .05], [.35, .7, .22], headGroup);

    const hairCap = makeMesh(
      new THREE.SphereGeometry(1.16, 48, 30, 0, Math.PI * 2, 0, Math.PI * .62),
      hairMaterial,
      [0, 1.42, -.05],
      [.85, .83, .83],
      headGroup
    );
    hairCap.rotation.z = -.03;
    makeMesh(new THREE.SphereGeometry(.4, 30, 22), hairMaterial, [-.55, 1.75, -.12], [.8, .75, .72], headGroup);
    makeMesh(new THREE.SphereGeometry(.44, 30, 22), hairMaterial, [.43, 1.79, -.13], [.9, .72, .72], headGroup);
    makeMesh(new THREE.SphereGeometry(.47, 30, 22), hairMaterial, [.02, 2.02, -.32], [.78, .65, .7], headGroup);
    const leftLock = makeMesh(new THREE.CapsuleGeometry(.16, 1.05, 8, 20), hairMaterial, [-.83, .72, -.24], [.9, 1, .78], headGroup);
    const rightLock = makeMesh(new THREE.CapsuleGeometry(.16, .95, 8, 20), hairMaterial, [.83, .77, -.24], [.9, 1, .78], headGroup);
    leftLock.rotation.z = .06;
    rightLock.rotation.z = -.06;

    const eyeGroups = [];
    const irises = [];
    [-.35, .35].forEach((x) => {
      const eyeGroup = new THREE.Group();
      eyeGroup.position.set(x, 1.08, .79);
      headGroup.add(eyeGroup);
      makeMesh(new THREE.SphereGeometry(.145, 28, 20), sclera, [0, 0, 0], [1.22, .78, .55], eyeGroup);
      const iris = makeMesh(new THREE.SphereGeometry(.068, 24, 18), irisMaterial, [0, 0, .112], [1, 1, .42], eyeGroup);
      makeMesh(new THREE.SphereGeometry(.032, 20, 14), pupilMaterial, [0, 0, .143], [1, 1, .35], eyeGroup);
      makeMesh(new THREE.SphereGeometry(.012, 12, 10), sclera, [-.016, .017, .16], [1, 1, .3], eyeGroup);
      eyeGroups.push(eyeGroup);
      irises.push(iris);
      const brow = makeMesh(new THREE.CapsuleGeometry(.025, .29, 5, 14), hairMaterial, [x, 1.36, .79], [1, 1, .55], headGroup);
      brow.rotation.z = x < 0 ? -1.68 : 1.68;
    });

    const noseBridge = makeMesh(new THREE.SphereGeometry(.18, 28, 20), skin, [0, .91, .81], [.44, 1.25, .64], headGroup);
    noseBridge.rotation.x = -.12;
    makeMesh(new THREE.SphereGeometry(.13, 24, 18), skinWarm, [0, .7, .89], [.8, .55, .65], headGroup);
    const mouthInner = makeMesh(new THREE.SphereGeometry(.19, 28, 20), mouthInnerMaterial, [0, .43, .79], [1.25, .23, .35], headGroup);
    const upperLip = makeMesh(new THREE.SphereGeometry(.13, 24, 16), lipMaterial, [0, .46, .91], [1.45, .25, .28], headGroup);
    const lowerLip = makeMesh(new THREE.SphereGeometry(.13, 24, 16), lipMaterial, [0, .39, .91], [1.5, .3, .28], headGroup);
    makeMesh(new THREE.SphereGeometry(.2, 24, 18), skinWarm, [-.43, .67, .72], [1.05, .55, .3], headGroup);
    makeMesh(new THREE.SphereGeometry(.2, 24, 18), skinWarm, [.43, .67, .72], [1.05, .55, .3], headGroup);

    const earringLeft = makeMesh(new THREE.TorusGeometry(.08, .014, 10, 28), metal, [-.92, .78, .07], [1, 1, 1], headGroup);
    const earringRight = makeMesh(new THREE.TorusGeometry(.08, .014, 10, 28), metal, [.92, .78, .07], [1, 1, 1], headGroup);
    earringLeft.rotation.y = earringRight.rotation.y = Math.PI / 2;

    const halo = makeMesh(
      new THREE.TorusGeometry(2.25, .008, 8, 100),
      new THREE.MeshBasicMaterial({ color: 0x63efb2, transparent: true, opacity: .22 }),
      [0, .25, -1.15],
      [1, 1, 1],
      scene
    );
    halo.rotation.x = Math.PI / 2.45;

    scene.add(new THREE.HemisphereLight(0xc6ffe2, 0x05100a, 2.35));
    const key = new THREE.DirectionalLight(0xffe5d5, 4.1);
    key.position.set(-3.5, 4.5, 5.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fd9ff, 1.7);
    fill.position.set(3.2, 2.5, 4);
    scene.add(fill);
    const rim = new THREE.PointLight(0x63efb2, 24, 12);
    rim.position.set(2.8, 2.2, 1.4);
    scene.add(rim);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);
    $("#avatarFallback").hidden = true;

    let nextBlink = 1800 + Math.random() * 1800;
    let blinkStarted = -1;
    const animate = (time) => {
      if (state.completing) return;
      if (time > nextBlink && blinkStarted < 0) {
        blinkStarted = time;
        nextBlink = time + 2600 + Math.random() * 3200;
      }
      let blinkAmount = 0;
      if (blinkStarted >= 0) {
        const phase = (time - blinkStarted) / 170;
        blinkAmount = phase < .5 ? phase * 2 : Math.max(0, 2 - phase * 2);
        if (phase >= 1) blinkStarted = -1;
      }
      eyeGroups.forEach((eye, index) => {
        eye.scale.y = Math.max(.09, 1 - blinkAmount * .91);
        eye.rotation.y = Math.sin(time * .00055 + index * .35) * .025;
      });
      irises.forEach((iris, index) => {
        iris.position.x = Math.sin(time * .00042 + index * .16) * .008;
      });
      const speechPulse = state.mayaSpeaking ? .45 + Math.abs(Math.sin(time * .016)) * .85 : .2;
      mouthInner.scale.y = speechPulse;
      lowerLip.position.y = .39 - (state.mayaSpeaking ? speechPulse * .035 : 0);
      upperLip.position.y = .46 + (state.mayaSpeaking ? speechPulse * .012 : 0);
      headGroup.rotation.y = Math.sin(time * .00038) * .035;
      headGroup.rotation.x = state.mayaSpeaking
        ? Math.sin(time * .0028) * .025
        : state.candidateSpeaking ? -.018 : Math.sin(time * .00062) * .012;
      avatar.position.y = -.15 + Math.sin(time * .00105) * .015;
      leftArm.rotation.z = -.12 - (state.mayaSpeaking ? Math.sin(time * .0022) * .035 : 0);
      rightArm.rotation.z = .12 + (state.mayaSpeaking ? Math.sin(time * .0022 + 1.2) * .035 : 0);
      halo.rotation.z = time * .00004;
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    state.avatar = { renderer, scene, avatar, headGroup };
  } catch {
    // The CSS avatar remains available if WebGL or the module CDN is unavailable.
  }
}

$("#privacyOpen").addEventListener("click", () => $("#privacyDialog").showModal());
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $("#privacyDialog").close()));

$("#endInterview").addEventListener("click", () => {
  if (confirm("End this session and prepare the recap?")) completeInterview();
});

async function completeInterview() {
  if (state.completing) return;
  state.completing = true;
  clearInterval(state.timer);
  state.visionRunning = false;
  state.channel?.close();
  state.peer?.close();
  state.remoteAudio?.pause();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.stream?.getTracks().forEach((track) => track.stop());
  interviewView.hidden = true;
  completeView.hidden = false;
  $("#finalEventCount").textContent = state.eventCount;
  $("#answeredCount").textContent = state.turnCount;
  $("#totalDuration").textContent = formatDuration(Math.floor((Date.now() - state.startedAt) / 1000));
  refreshIcons();
  try {
    const payload = await api(`/api/interviews/${state.interviewId}/complete/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderSummary(payload.summary);
    $("#answeredCount").textContent = payload.answer_count ?? state.turnCount;
  } catch (error) {
    $("#summaryPanel").innerHTML = `<h3>Session saved</h3><p></p>`;
    $("#summaryPanel p").textContent = `The recap could not be prepared yet: ${error.message}`;
  }
}

function renderSummary(summary = {}) {
  const strengths = Array.isArray(summary.demonstrated) ? summary.demonstrated : [];
  const followups = Array.isArray(summary.follow_up) ? summary.follow_up : [];
  $("#summaryPanel").innerHTML = `
    <h3>Discussion recap</h3>
    <p class="summary-intro"></p>
    <div class="summary-grid">
      <div><h4>DEMONSTRATED IN THE CONVERSATION</h4><ul class="strength-list"></ul></div>
      <div><h4>USEFUL HUMAN FOLLOW-UP</h4><ul class="follow-list"></ul></div>
    </div>`;
  $("#summaryPanel .summary-intro").textContent = summary.overview || "Your conversation was completed and is ready for review.";
  const fill = (selector, items, fallback) => {
    const list = $(selector);
    (items.length ? items : [fallback]).forEach((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      list.appendChild(item);
    });
  };
  fill(".strength-list", strengths, "Review the candidate’s examples and outcomes in the transcript.");
  fill(".follow-list", followups, "Validate role-specific depth in a human follow-up.");
}

$("#newInterview").addEventListener("click", () => window.location.reload());

window.addEventListener("beforeunload", (event) => {
  if (!interviewView.hidden && !state.completing) {
    event.preventDefault();
    event.returnValue = "";
  }
});
