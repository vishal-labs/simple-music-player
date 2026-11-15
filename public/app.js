// Front end for the music player. Plain JavaScript, no build step.

const $ = (selector, root = document) => root.querySelector(selector);
const NBSP = ' ';
const COLUMNS = 32; // width of the player block, in characters
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/* ---------- saved settings (per browser) ---------- */

const store = {
	get(key, fallback) {
		try {
			const raw = localStorage.getItem(`music-player:${key}`);
			return raw === null ? fallback : JSON.parse(raw);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(`music-player:${key}`, JSON.stringify(value));
		} catch {
			/* private mode or storage full: settings just won't persist */
		}
	},
	remove(key) {
		try {
			localStorage.removeItem(`music-player:${key}`);
		} catch {
			/* ignore */
		}
	},
};

/* ---------- state ---------- */

const state = {
	title: 'music',
	collections: [], // [{ slug, title, tracks: [{ id, title, duration, collection }] }]
	error: null,
	route: null, // slug of the folder shown in the middle column
	mode: 'empty', // 'empty' | 'playing' | 'paused'
	track: null,
	queue: [], // the list the current track was started from
	volume: store.get('volume', 100),
	shuffle: store.get('shuffle', false),
	repeat: store.get('repeat', 'off'), // 'off' | 'all' | 'one'
	invert: store.get('invert', false),
	favourites: new Set(store.get('favourites', [])),
};

const allTracks = () => state.collections.flatMap((collection) => collection.tracks);

function favouritesCollection() {
	return {
		slug: 'favourites',
		title: 'Favourites',
		tracks: allTracks().filter((track) => state.favourites.has(track.id)),
	};
}

function findCollection(slug) {
	if (slug === 'favourites') return favouritesCollection();
	return state.collections.find((collection) => collection.slug === slug) || null;
}

/* ---------- formatting ---------- */

const pad2 = (n) => String(n).padStart(2, '0');

function clock(seconds) {
	const s = Math.max(0, Math.floor(seconds || 0));
	return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function shortTime(seconds) {
	if (seconds === null || seconds === undefined) return '--:--';
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- the "decode" text transition ---------- */

const GLYPHS = '—~±§|[].+$^@*()•x%!?#';

function textNodes(root) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue.trim() !== '') nodes.push(node);
	}
	return nodes;
}

const running = new WeakMap(); // element -> function that finishes its animation now

/** Types the element's text in from the left behind a short edge of random glyphs. */
function decode(root, { duration = 1000, delay = 0 } = {}) {
	if (reducedMotion || !root) return;
	running.get(root)?.();

	const nodes = textNodes(root);
	const originals = nodes.map((node) => node.nodeValue);
	const total = originals.reduce((sum, text) => sum + text.length, 0);
	if (total === 0) return;
	const edge = Math.max(6, Math.min(48, Math.round(total * 0.12)));
	let stopped = false;

	const finish = () => {
		if (stopped) return;
		stopped = true;
		nodes.forEach((node, i) => {
			node.nodeValue = originals[i];
		});
		running.delete(root);
	};
	running.set(root, finish);

	const paint = (progress) => {
		const shown = Math.floor(total * progress);
		let offset = 0;
		for (let i = 0; i < nodes.length; i++) {
			const text = originals[i];
			let out = '';
			for (let j = 0; j < text.length; j++) {
				const position = offset + j;
				const ch = text[j];
				if (position < shown || ch === ' ' || ch === NBSP) out += ch;
				else if (position < shown + edge && Math.random() < 0.55) out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
				else out += ' ';
			}
			nodes[i].nodeValue = out;
			offset += text.length;
		}
	};

	paint(0);
	const start = performance.now() + delay;
	let lastPaint = 0;
	const frame = (now) => {
		if (stopped) return;
		if (!root.isConnected) return finish();
		const t = Math.min(1, Math.max(0, (now - start) / duration));
		if (t >= 1) return finish();
		if (now - lastPaint > 30) {
			const eased = Math.pow((1 - Math.cos(Math.PI * t)) / 2, 2);
			paint(eased);
			lastPaint = now;
		}
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}

/* ---------- audio ---------- */

const audio = new Audio();
audio.preload = 'metadata';

// iOS silences audio that is routed through Web Audio once the screen locks,
// so there the file plays directly and the spectrum display stays flat.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const useGraph = !isIOS && Boolean(AudioContextClass);

let context = null;
let analyser = null;
let gain = null;
let spectrum = null;

const volumeGain = () => Math.pow(state.volume / 100, 1.666);

function applyVolume() {
	if (gain) gain.gain.value = volumeGain();
	else audio.volume = volumeGain();
}

/** Browsers only allow audio to start from a click, so this runs on first use. */
function ensureGraph() {
	if (!useGraph) return;
	if (!context) {
		context = new AudioContextClass();
		const source = context.createMediaElementSource(audio);
		analyser = context.createAnalyser();
		analyser.fftSize = 2048;
		analyser.minDecibels = -105;
		analyser.maxDecibels = -28;
		analyser.smoothingTimeConstant = 0.68;
		spectrum = new Uint8Array(analyser.frequencyBinCount);
		gain = context.createGain();
		source.connect(analyser);
		source.connect(gain);
		gain.connect(context.destination);
		audio.volume = 1;
		applyVolume();
	}
	if (context.state === 'suspended') context.resume();
}

/** The interface sound: a 20 ms square-wave tick, synthesized, no audio file. */
function blip() {
	if (!context || !gain) return;
	const oscillator = context.createOscillator();
	const level = context.createGain();
	oscillator.type = 'square';
	oscillator.frequency.value = 5555;
	level.gain.value = 0.125;
	oscillator.connect(level);
	level.connect(gain);
	oscillator.start();
	oscillator.stop(context.currentTime + 0.02);
}

/* ---------- spectrum display (drawn as text) ---------- */

const RAMP = "_.-•:*^º'";
const vizRows = [0, 1, 2, 3].map((row) => $(`#viz-${row}`));
const blankRow = NBSP.repeat(COLUMNS);
let lastViz = '';

function drawSpectrum() {
	const rows = ['', '', '', ''];
	const live = analyser && state.mode === 'playing';
	if (live) analyser.getByteFrequencyData(spectrum);
	let bin = 1;
	for (let band = 0; band < COLUMNS; band++) {
		let level = 0;
		if (live) {
			const next = Math.max(bin + 1, bin * 1.225);
			let peak = 0;
			for (let i = Math.floor(bin); i < Math.floor(next) && i < spectrum.length; i++) {
				if (spectrum[i] > peak) peak = spectrum[i];
			}
			bin = next;
			// higher bands carry less energy, so lift them a little
			level = Math.max(0, Math.min(35, Math.floor((peak - 38 + band * 1.5) / 6.2)));
		}
		const rowIndex = Math.floor(level / RAMP.length);
		for (let row = 0; row < 4; row++) rows[row] += row === rowIndex ? RAMP[level % RAMP.length] : NBSP;
	}
	const signature = rows.join('');
	if (signature !== lastViz) {
		lastViz = signature;
		for (let row = 0; row < 4; row++) vizRows[row].textContent = rows[row];
	}
	requestAnimationFrame(drawSpectrum);
}

/* ---------- marquee ---------- */

const marqueeNode = $('#marquee');
let marqueeText = '';
let marqueeOffset = 0;

function setMarquee(text) {
	marqueeText = text ? `${text.replaceAll(' ', NBSP)}${NBSP}•${NBSP}` : '';
	marqueeOffset = 0;
	tickMarquee();
}

function tickMarquee() {
	if (!marqueeText) {
		marqueeNode.textContent = blankRow;
		return;
	}
	let out = '';
	for (let i = 0; i < COLUMNS; i++) out += marqueeText[(marqueeOffset + i) % marqueeText.length];
	marqueeNode.textContent = out;
	marqueeOffset = (marqueeOffset + 1) % marqueeText.length;
}
setInterval(tickMarquee, 500);

/* ---------- playback ---------- */

const LONG_TRACK = 600; // seconds; longer tracks remember where you stopped

function savePosition() {
	const track = state.track;
	if (!track || !(audio.duration > LONG_TRACK)) return;
	if (audio.currentTime > 5 && audio.currentTime < audio.duration - 10) {
		store.set(`position:${track.id}`, Math.floor(audio.currentTime));
	}
}

function playTrack(track, queue) {
	ensureGraph();
	savePosition();
	state.track = track;
	state.queue = queue && queue.length ? queue : [track];
	state.mode = 'playing';
	audio.src = `/audio/${track.id}`;
	const resumeAt = store.get(`position:${track.id}`, 0);
	if (resumeAt > 0) {
		audio.addEventListener(
			'loadedmetadata',
			() => {
				if (state.track === track && resumeAt < audio.duration - 10) audio.currentTime = resumeAt;
			},
			{ once: true },
		);
	}
	audio.play().catch(() => {});
	blip();
	setMarquee(`${track.collection.title} / ${track.title}`);
	updateMediaSession();
	renderPlayer();
	markPlaying();
}

function toggle() {
	if (!state.track) return;
	ensureGraph();
	if (state.mode === 'playing') {
		audio.pause();
		state.mode = 'paused';
		savePosition();
	} else {
		audio.play().catch(() => {});
		state.mode = 'playing';
	}
	blip();
	renderPlayer();
}

function neighbour(step) {
	const index = state.queue.indexOf(state.track);
	if (index === -1) return null;
	const target = index + step;
	if (target >= 0 && target < state.queue.length) return state.queue[target];
	return state.repeat === 'all' ? state.queue[(target + state.queue.length) % state.queue.length] : null;
}

function randomFrom(list) {
	if (list.length < 2) return list[0] || null;
	let pick = state.track;
	while (pick === state.track) pick = list[Math.floor(Math.random() * list.length)];
	return pick;
}

function nextTrack() {
	return state.shuffle ? randomFrom(state.queue) : neighbour(1);
}

function seek(delta) {
	if (!state.track || !Number.isFinite(audio.duration)) return;
	audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), Math.max(0, audio.duration - 1));
	blip();
	renderClock();
}

function changeVolume(delta) {
	state.volume = Math.min(100, Math.max(10, state.volume + delta));
	store.set('volume', state.volume);
	applyVolume();
	blip();
	renderPlayer();
}

function playRandom() {
	const track = randomFrom(allTracks());
	if (track) playTrack(track, track.collection.tracks);
}

audio.addEventListener('ended', () => {
	const finished = state.track;
	if (finished) store.remove(`position:${finished.id}`);
	if (state.repeat === 'one' && finished) {
		audio.currentTime = 0;
		audio.play().catch(() => {});
		return;
	}
	const next = nextTrack();
	if (next) {
		playTrack(next, state.queue);
	} else {
		state.mode = 'paused';
		renderPlayer();
	}
});

audio.addEventListener('pause', () => {
	// paused from outside the page (headphone button, lock screen, a phone call)
	if (state.mode === 'playing' && !audio.ended) {
		state.mode = 'paused';
		renderPlayer();
	}
});

audio.addEventListener('play', () => {
	if (state.mode === 'paused') {
		state.mode = 'playing';
		renderPlayer();
	}
});

audio.addEventListener('error', () => {
	if (!state.track) return;
	setMarquee(`cannot play ${state.track.title}`);
	state.mode = 'paused';
	renderPlayer();
});

audio.addEventListener('timeupdate', renderClock);
setInterval(savePosition, 5000);
addEventListener('pagehide', savePosition);

function updateMediaSession() {
	if (!('mediaSession' in navigator) || !state.track) return;
	navigator.mediaSession.metadata = new MediaMetadata({
		title: state.track.title,
		artist: state.track.collection.title,
		album: state.title,
	});
}

if ('mediaSession' in navigator) {
	const handlers = {
		play: () => state.mode !== 'playing' && toggle(),
		pause: () => state.mode === 'playing' && toggle(),
		previoustrack: () => {
			const track = neighbour(-1);
			if (track) playTrack(track, state.queue);
		},
		nexttrack: () => {
			const track = nextTrack();
			if (track) playTrack(track, state.queue);
		},
		seekbackward: () => seek(-30),
		seekforward: () => seek(30),
	};
	for (const [action, handler] of Object.entries(handlers)) {
		try {
			navigator.mediaSession.setActionHandler(action, handler);
		} catch {
			/* action not supported by this browser */
		}
	}
}

/* ---------- player block ---------- */

const playerButtons = Object.fromEntries(
	[...document.querySelectorAll('#player [data-act]')].map((button) => [button.dataset.act, button]),
);

const actions = {
	prev: () => {
		const track = neighbour(-1);
		if (track) playTrack(track, state.queue);
	},
	back: () => seek(-30),
	toggle,
	forward: () => seek(30),
	next: () => {
		const track = nextTrack();
		if (track) playTrack(track, state.queue);
	},
	quieter: () => changeVolume(-5),
	louder: () => changeVolume(5),
	random: playRandom,
};

function setButton(name, label, colour, enabled) {
	const button = playerButtons[name];
	button.textContent = `[${label}]`;
	button.disabled = !enabled;
	button.className = enabled ? `${colour} hover` : '';
}

function renderPlayer() {
	const active = state.mode !== 'empty';
	const hasPrev = active && neighbour(-1) !== null;
	const hasNext = active && (state.shuffle ? state.queue.length > 1 : neighbour(1) !== null);
	setButton('prev', active ? 'prev' : '----', 'green', hasPrev);
	setButton('back', active ? '-30' : '---', 'green', active);
	setButton('toggle', !active ? '----' : state.mode === 'playing' ? 'stop' : 'play', 'green', active);
	setButton('forward', active ? '+30' : '---', 'green', active);
	setButton('next', active ? 'next' : '----', 'green', hasNext);
	setButton('quieter', active ? 'v-' : '--', 'purple', active);
	setButton('louder', active ? 'v+' : '--', 'purple', active);
	$('#volume').textContent = active ? `${String(state.volume).padEnd(3, NBSP)}%` : '....';
	renderClock();
}

function renderClock() {
	$('#clock').textContent = state.mode === 'empty' ? '--:--:--' : clock(audio.currentTime);
}

$('#player').addEventListener('click', (event) => {
	const button = event.target.closest('[data-act]');
	if (button && !button.disabled) actions[button.dataset.act]();
});

/* ---------- options ---------- */

function renderOptions() {
	$('[data-opt="shuffle"]').textContent = `[shuffle:${state.shuffle ? 'on' : 'off'}]`;
	$('[data-opt="repeat"]').textContent = `[repeat:${state.repeat}]`;
	document.documentElement.classList.toggle('invert', state.invert);
	$('meta[name="theme-color"]').content = state.invert ? '#d5d5d5' : '#1a1a1a';
}

const options = {
	shuffle() {
		state.shuffle = !state.shuffle;
		store.set('shuffle', state.shuffle);
	},
	repeat() {
		state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
		store.set('repeat', state.repeat);
	},
	invert() {
		state.invert = !state.invert;
		store.set('invert', state.invert);
	},
	fullscreen() {
		if (document.fullscreenElement) document.exitFullscreen?.();
		else document.documentElement.requestFullscreen?.();
	},
	async rescan() {
		const button = $('[data-opt="rescan"]');
		button.textContent = '[scanning]';
		try {
			await fetch('/api/rescan', { method: 'POST' });
			await loadLibrary();
			renderAll();
		} catch {
			/* server unreachable: keep showing what we have */
		}
		button.textContent = '[rescan]';
	},
};

$('#links').addEventListener('click', async (event) => {
	const button = event.target.closest('[data-opt]');
	if (!button) return;
	await options[button.dataset.opt]();
	blip();
	renderOptions();
	renderPlayer();
});

/* ---------- right column: folders ---------- */

function renderFolders() {
	const list = el('div', 'list green');
	const entries = [...state.collections];
	if (state.favourites.size > 0) entries.unshift(favouritesCollection());
	for (const collection of entries) {
		const current = collection.slug === state.route;
		const link = el(current ? 'span' : 'a', current ? 'selected' : '');
		if (collection.slug === 'favourites') link.classList.add('yellow');
		if (!current) link.href = `#/${collection.slug}`;
		link.append(el('em', '', collection.title));
		list.append(link, ' ', el('span', 'grey count', String(collection.tracks.length)), el('br'));
	}
	$('#folders').replaceChildren(list);
	return list;
}

/* ---------- middle column: one folder ---------- */

function renderContent() {
	const content = $('#content');
	const wrapper = el('div', 'pad');
	const collection = findCollection(state.route);

	if (state.error || !collection) {
		wrapper.append(el('h1', 'title', state.error ? 'No music found' : 'Nothing here'));
		wrapper.append(
			el(
				'div',
				'notice orange',
				state.error ||
					(state.collections.length
						? 'That folder does not exist.'
						: 'The music folder is empty. Add audio files to it, then press [rescan].'),
			),
		);
		content.replaceChildren(wrapper);
		return wrapper;
	}

	wrapper.append(el('h1', 'title', collection.title));

	const total = collection.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
	const meta = el('nav', 'meta noselect');
	const playAll = el('button', 'green hover', '[play all]');
	playAll.addEventListener('click', () => {
		const first = state.shuffle ? randomFrom(collection.tracks) : collection.tracks[0];
		if (first) playTrack(first, collection.tracks);
	});
	meta.append(playAll, ' ', el('span', 'grey', `${plural(collection.tracks.length, 'song')} • ${shortTime(total)}`));
	wrapper.append(meta);

	const tracks = el('div', 'tracks');
	for (const track of collection.tracks) {
		const row = el('div', 'track');
		row.dataset.id = track.id;

		const favourite = el('button', 'hover noselect');
		favourite.dataset.fav = track.id;
		favourite.setAttribute('aria-label', `Favourite ${track.title}`);
		paintFavourite(favourite);

		const name = el('button', 'name hover white', track.title);
		name.dataset.play = track.id;

		row.append(favourite, name, el('span', 'length grey noselect', shortTime(track.duration)));
		tracks.append(row);
	}
	tracks.addEventListener('click', (event) => {
		const play = event.target.closest('[data-play]');
		const fav = event.target.closest('[data-fav]');
		if (play) {
			const track = collection.tracks.find((item) => item.id === play.dataset.play);
			if (track === state.track) toggle();
			else if (track) playTrack(track, collection.tracks);
		} else if (fav) {
			toggleFavourite(fav.dataset.fav);
			paintFavourite(fav);
		}
	});
	wrapper.append(tracks);

	content.replaceChildren(wrapper);
	markPlaying();
	return wrapper;
}

function paintFavourite(button) {
	const on = state.favourites.has(button.dataset.fav);
	button.textContent = on ? '[*]' : '[ ]';
	button.classList.toggle('yellow', on);
	button.classList.toggle('grey', !on);
	button.setAttribute('aria-pressed', String(on));
}

function toggleFavourite(id) {
	if (state.favourites.has(id)) state.favourites.delete(id);
	else state.favourites.add(id);
	store.set('favourites', [...state.favourites]);
	blip();
	renderFolders();
}

/** Highlights the row of the track that is loaded in the player. */
function markPlaying() {
	for (const row of document.querySelectorAll('#content .track')) {
		const name = $('.name', row);
		const current = state.track !== null && row.dataset.id === state.track.id;
		name.classList.toggle('selected', current);
		name.classList.toggle('green', current);
		name.classList.toggle('white', !current);
	}
}

/* ---------- stats ---------- */

function renderStats() {
	const tracks = allTracks();
	const seconds = tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
	const lines = [
		plural(state.collections.length, 'folder'),
		plural(tracks.length, 'song'),
		plural(Math.floor(seconds / 3600), 'hour'),
		plural(Math.floor((seconds % 3600) / 60), 'minute'),
	];
	const stats = $('#stats');
	stats.replaceChildren();
	for (const line of lines) stats.append(`// ${line}`, el('br'));
}

/* ---------- routing and startup ---------- */

function currentRoute() {
	let slug = '';
	try {
		slug = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
	} catch {
		/* malformed link: fall back to the first folder */
	}
	if (slug && findCollection(slug)) return slug;
	return state.collections[0]?.slug ?? null;
}

async function loadLibrary() {
	const response = await fetch('/api/library');
	if (!response.ok) throw new Error(`library request failed (${response.status})`);
	const data = await response.json();
	const playingId = state.track?.id;
	state.title = data.title || 'music';
	state.error = data.error;
	state.collections = data.collections;
	for (const collection of state.collections) {
		for (const track of collection.tracks) track.collection = collection;
	}
	if (playingId) {
		// keep the playing track pointing at the fresh objects after a rescan
		const fresh = allTracks().find((track) => track.id === playingId);
		if (fresh) {
			state.track = fresh;
			state.queue = fresh.collection.tracks;
		}
	}
	document.title = `${state.title}();`;
	for (const node of document.querySelectorAll('[data-site-title]')) node.textContent = state.title;
}

function renderAll() {
	state.route = currentRoute();
	renderStats();
	renderOptions();
	renderPlayer();
	return { folders: renderFolders(), content: renderContent() };
}

addEventListener('hashchange', () => {
	state.route = currentRoute();
	renderFolders();
	decode(renderContent(), { duration: 700 });
	$('#content').scrollTo?.({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
	if (matchMedia('(max-width: 767px)').matches) $('#content').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
});

addEventListener('keydown', (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.target.closest('input, textarea, select')) return;
	const onButton = Boolean(event.target.closest('button, a'));
	if (event.key === ' ' && !onButton) {
		event.preventDefault();
		toggle();
	} else if (event.key === 'ArrowLeft') seek(-30);
	else if (event.key === 'ArrowRight') seek(30);
});

async function start() {
	renderOptions();
	setMarquee('');
	drawSpectrum();
	try {
		await loadLibrary();
	} catch (error) {
		state.error = `Could not reach the server: ${error.message}`;
	}
	const { folders, content } = renderAll();
	decode($('#tagline'), { duration: 2000 });
	decode($('#player > div:nth-of-type(3)'), { duration: 500 });
	decode($('#player > div:nth-of-type(4)'), { duration: 500 });
	decode($('#links'), { duration: 2000 });
	decode($('#stats'), { duration: 2000 });
	decode(content, { duration: 1000 });
	decode(folders, { duration: 2000, delay: 300 });
}

start();
