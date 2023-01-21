function CreateWatcherWorker(dir: string, ext: string) {
	const workerFunction = `async (dir:string)=>{
        const watcher = Deno.watchFs(normalize(dir.replaceAll('"',"")), {recursive: true});

        const filemap:Map<string,boolean> = new Map();
        for await (const event of watcher) {
            const { kind, paths } = event;
            if (kind === "create" || kind === "modify" || kind === "delete") {

                const file:string = paths[0] ?? "";
                if (file.endsWith("${ext}")) {

                    if (!filemap.has(file)) {
                        filemap.set(file, true);
                        self.postMessage( JSON.stringify({ path : normalize(file), event : kind }));
                        setTimeout(()=>{
                            filemap.delete(file);
                        },200);
                    }
                }
            }
        }
    }`;
	const blob = new Blob([`import { globToRegExp, join, normalize } from "https://deno.land/std@0.153.0/path/mod.ts"; (${workerFunction})('${JSON.stringify(dir)}')`], { type: "application/typescript" });
	const worker = new Worker(URL.createObjectURL(blob), {
		type: "module",
	});
	return worker;
}

export { CreateWatcherWorker };
