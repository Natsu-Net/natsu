import { decompress } from "https://deno.land/x/zip@v1.2.4/mod.ts";

const filesURL = "https://natsu-net.xyz/templates.zip";
const ZipFile = "templates.zip";

async function download( dest : string ) {
    const files = await fetch(filesURL);
    const zipDest = `${Deno.cwd()}/${ZipFile}`;
    console.log(`Downloading ${filesURL} to ${zipDest}`);
    // convert ArrayBuffer to Uint8Array
    const filesArray = new Uint8Array(await files.arrayBuffer());
    // write file
    console.log(`Writing ${zipDest}`);
    await Deno.writeFile(zipDest, filesArray);

    console.log(`Extracting ${zipDest} to ${dest}`);
    // decompress
    await decompress(zipDest);
    console.log(`Extracted ${zipDest} to ${dest}`);

    // remove zip file
    await Deno.remove(zipDest);

    return true;
}

export { download };
