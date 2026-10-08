/**
 * What a source, a model resolver or a page can throw.
 *
 * Templates hold no rules: whether a visitor may see a product, and whether
 * it exists, is the source's call. It says so by throwing (or returning) one
 * of these, and the page answers with that status, through `_error.uwu` when
 * the app has one.
 */

/** An answer with an HTTP status rather than a page. */
export class HttpError extends Error {
	public readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/** 404: what was asked for does not exist (or this visitor must not learn that it does). */
export class NotFound extends HttpError {
	constructor(message = "Not Found") {
		super(404, message);
		this.name = "NotFound";
	}
}

/** 403: it exists, and this visitor may not see it. */
export class Forbidden extends HttpError {
	constructor(message = "Forbidden") {
		super(403, message);
		this.name = "Forbidden";
	}
}

/**
 * Go elsewhere instead: a page that has moved, or one that needs a sign-in
 * first. A page answers it with its status (302 unless given) and the
 * location; a soft visit is told where to go; an action's post goes there
 * with a 303. The location must be a path on this site.
 */
export class Redirect extends HttpError {
	public readonly location: string;

	constructor(location: string, status = 302) {
		super(status, "Redirect");
		this.name = "Redirect";
		this.location = location;
	}
}

/**
 * A page file natsu cannot serve: a bad `<page>` block, a name nothing
 * provides, a template uwu refuses. Thrown when the pages are compiled or
 * mounted, never per request; the message names the file and the line.
 */
export class PageCompileError extends Error {
	public readonly file: string;
	public readonly line: number;

	constructor(file: string, line: number, message: string) {
		super(`${file}:${line}: ${message}`);
		this.name = "PageCompileError";
		this.file = file;
		this.line = line;
	}
}
