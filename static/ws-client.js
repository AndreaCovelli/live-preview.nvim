const wsUrl = getWebSocketUrl();
let socket = null;
// Whether the socket has opened at least once since the page loaded
let everConnected = false;
// Whether the socket dropped, so updates may have been missed
let disconnected = false;
// ETag of the previewed file when the page last matched it on disk. Rendered pages
// carry it, so a page the browser restored from its cache is checked against the file.
let sourceEtag = document.querySelector('meta[name="livepreview-etag"]')?.content ?? null;
// An update from Neovim is newer than the file on disk, so it wins over a resync
let updatedSinceReconnect = false;

function getWebSocketUrl() {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const hostname = window.location.hostname;
	const port = window.location.port ? `:${window.location.port}` : "";
	return `${protocol}//${hostname}${port}`;
}

/**
 * Normalize Windows file path to use forward slashes
 * @param {string} filepath - The file path to normalize
 * @returns {string} - The normalized file path
 */
const normalizePath = (filepath) => {
    if (!filepath) return '';

    const isWindows = /^[a-zA-Z]:\\/.test(filepath) ||
                      filepath.startsWith('\\\\');

    return isWindows ? filepath.replace(/\\/g, '/') : filepath;
};

/**
 * Check if browser should handle websocket message from server
 * @param {string} filepath - The path of the file
 * @returns {boolean} - True if the browser should handle the message, false otherwise
 */
const isRightPath = (filepath) => {
	const decodedPath = decodeURIComponent(window.location.pathname)
	console.log("Checking path:", filepath, "against", decodedPath);
    const normalized = normalizePath(filepath);
    return normalized.endsWith(decodedPath);
};

/**
 * Check if the page renders its source in the browser (markdown, asciidoc, svg),
 * so it can be updated in place rather than reloaded
 * @returns {boolean}
 */
const isRenderedPage = () =>
	typeof livepreview_render !== "undefined" || window.location.pathname.endsWith(".svg");

/**
 * Render markdown or asciidoc source with the page's renderer
 * @param {string} content - The source of the file
 */
const renderSource = (content) => {
	livepreview_render(content);
	if (typeof livepreview_renderKatex !== "undefined") {
		livepreview_renderKatex();
	}
	if (typeof livepreview_renderMermaid !== "undefined") {
		livepreview_renderMermaid();
	}
};

/**
 * Render the source of the previewed file into the page
 * @param {string} content - The source of the file
 */
const renderContent = (content) => {
	// Check if the render function is defined before calling it
	if (typeof livepreview_render !== "undefined") {
		renderSource(content);
	} else if (window.location.pathname.endsWith(".svg")) {
		// Check if viewing svg
		document.querySelector('.markdown-body').innerHTML = content;
	} else {
		console.error("livepreview_render function is not defined");
	}
};

/**
 * Fetch the previewed file. Without text/html in Accept, the server sends its
 * source as is rather than wrapped in a page.
 * @returns {Promise<Response>}
 */
const fetchSource = () =>
	fetch(window.location.href, { cache: "no-store", headers: { Accept: "*/*" } });

/**
 * Bring the page up to date with the file, after a reconnect or when the page came
 * from the browser cache. Reloading would lose the scroll position, and browsers
 * drop the socket whenever a background tab is frozen.
 */
async function resync() {
	if (!isRenderedPage()) {
		// HTML pages can't be patched in place, and their CSS or JS may have changed too
		window.location.reload();
		return;
	}
	try {
		const res = await fetchSource();
		const etag = res.headers.get("ETag");
		if (!res.ok || etag === sourceEtag) {
			return;
		}
		if (updatedSinceReconnect) {
			return;
		}
		if (typeof livepreview_render === "undefined") {
			// An SVG page: reload rather than insert fetched markup into it
			window.location.reload();
			return;
		}
		const content = await res.text();
		if (updatedSinceReconnect) {
			return;
		}
		sourceEtag = etag;
		console.log("File changed since the page was rendered, rendering it again");
		updateSourceView(content);
		renderSource(content);
	} catch (error) {
		console.error("Resync failed:", error);
	}
}

// Session storage key that keeps the source view across reloads of the page
const sourceViewKey = `livepreview-source:${window.location.pathname}`;
// Latest source sent by Neovim: newer than the file on disk while the buffer is unsaved
let latestSource = null;
// <pre> that shows the source in place of the rendering, created on first use
let sourceView = null;

/** @returns {boolean} - True if the source is shown instead of the rendering */
const isSourceShown = () => sourceView !== null && sourceView.style.display !== "none";

/**
 * Keep the source view in step with the source the page renders
 * @param {string} content - The source of the file
 */
const updateSourceView = (content) => {
	latestSource = content;
	if (sourceView) {
		sourceView.textContent = content;
	}
};

/**
 * Show the source of the page in place of its rendering, or the rendering again
 * @param {boolean} show - True to show the source
 */
async function showSource(show) {
	const rendering = document.querySelector(".markdown-body");
	if (!rendering) {
		return;
	}
	if (show) {
		let source = latestSource;
		if (source === null) {
			// ?raw makes the server send the file as is
			const url = new URL(window.location.href);
			url.searchParams.set("raw", "");
			url.hash = "";
			try {
				const res = await fetch(url, { cache: "no-cache" });
				if (!res.ok) {
					return;
				}
				source = await res.text();
			} catch (error) {
				console.error("Fetching the source failed:", error);
				return;
			}
		}
		if (!sourceView) {
			sourceView = document.createElement("pre");
			sourceView.className = "livepreview-source";
			sourceView.style.cssText =
				"margin:0;padding:16px 32px;white-space:pre-wrap;overflow-wrap:anywhere;" +
				"font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
			rendering.after(sourceView);
		}
		// An update may have arrived during the fetch
		sourceView.textContent = latestSource ?? source;
		sessionStorage.setItem(sourceViewKey, "1");
	} else {
		sessionStorage.removeItem(sourceViewKey);
	}
	// Hidden content is left out of select all and copy
	rendering.style.display = show ? "none" : "";
	if (sourceView) {
		sourceView.style.display = show ? "" : "none";
	}
}

// "r" toggles between the rendering and the source, e.g. to copy the Markdown
document.addEventListener("keydown", (event) => {
	if (event.key !== "r" || event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
		return;
	}
	const target = event.target;
	if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
		return;
	}
	if (!isRenderedPage()) {
		return;
	}
	event.preventDefault();
	showSource(!isSourceShown());
});

window.addEventListener("load", () => {
	if (isRenderedPage() && sessionStorage.getItem(sourceViewKey)) {
		showSource(true);
	}
});

function connectWebSocket() {
	socket = new WebSocket(wsUrl);

	socket.onopen = () => {
		console.log("Connected to server");
		// HTML pages carry no ETag: they were just loaded, so only a disconnect resyncs them
		if (disconnected || (!everConnected && sourceEtag !== null)) {
			updatedSinceReconnect = false;
			resync();
		}
		everConnected = true;
		disconnected = false;
	};

	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);

		if (message.type === "reload") {
			console.log("Reload message received");
			window.location.reload();
		} else if (message.type === "update") {
			console.log("Update message received");
			let { filepath, content } = message;
			if (isRightPath(filepath)) {
				updatedSinceReconnect = true;
				updateSourceView(content);
				renderContent(content);
			}
		} else if (message.type === "scroll") {
			console.log("Scroll message received");
			const { filepath, cursor } = message;
			if (isRightPath(filepath)) {
				const line = document.querySelector(`[data-source-line="${cursor[0]}"]`);
				if (line) {
					line.scrollIntoView({ behavior: "smooth", block: "center" });
				} else {
					// Find the closest line number
					const lineNumbers = document.querySelectorAll(".source-line");
					let closest = lineNumbers[0];
					let minDiff = Math.abs(cursor[0] - parseInt(closest.getAttribute("data-source-line")));
					lineNumbers.forEach((lineNumber) => {
						const diff = Math.abs(cursor[0] - parseInt(lineNumber.getAttribute("data-source-line")));
						if (diff < minDiff) {
							minDiff = diff;
							closest = lineNumber;
						}
					});
					closest.scrollIntoView({ behavior: "smooth", block: "center" });
				}
			}
		}
	};

	socket.onclose = () => {
		console.log("Disconnected from server");
		disconnected = true;
	};

	socket.onerror = (error) => {
		console.error("WebSocket error:", error);
	};
}

function reconnect() {
	// Leave a socket that is still connecting or closing alone
	if (socket && socket.readyState !== WebSocket.CLOSED) {
		return;
	}
	connectWebSocket();
}

window.onload = () => {
	connectWebSocket();
	setInterval(reconnect, 1000);
	// Timers barely run in a background tab, so don't wait for one on return
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			reconnect();
		}
	});
};
