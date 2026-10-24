/**
 * One shared preview voice for the Sounds panel: hovering a sound plays it (after a short intent delay, so sweeping
 * the mouse down the list does not spray audio), leaving stops it. Browsers only allow playback after the page has had
 * a user gesture; until then a hover is silently ignored.
 */
type Listener = (url: string | null) => void;

let audio: HTMLAudioElement | null = null;
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit() {
	for (const listener of listeners) listener(current);
}

export function onPreviewChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function previewingUrl(): string | null {
	return current;
}

export function stopPreview(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	if (audio) {
		audio.pause();
		audio.currentTime = 0;
	}
	if (current !== null) {
		current = null;
		emit();
	}
}

export function playPreview(url: string, { delay = 0, volume = 0.8 }: { delay?: number; volume?: number } = {}): void {
	if (timer) clearTimeout(timer);
	const start = () => {
		timer = null;
		if (!audio) audio = new Audio();
		audio.pause();
		audio.src = url;
		audio.volume = volume;
		audio.onended = () => {
			if (current === url) {
				current = null;
				emit();
			}
		};
		current = url;
		emit();
		audio.play().catch(() => {
			if (current === url) {
				current = null;
				emit();
			}
		});
	};
	if (delay > 0) timer = setTimeout(start, delay);
	else start();
}
