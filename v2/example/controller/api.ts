import { Controller, Get } from "../../index.ts";
import type { Context } from "../../src/context.ts";

/** The decorator form: the same registry, a different spelling. */
@Controller("/api")
class Api {
	private started = Date.now();

	@Get("/time")
	time(): Record<string, unknown> {
		return { now: new Date().toISOString(), uptimeMs: Date.now() - this.started };
	}

	@Get("/echo/:word")
	echo(ctx: Context): string {
		return ctx.params.word ?? "";
	}
}

export { Api };
