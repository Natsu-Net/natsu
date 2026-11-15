export type AssetRule = string | RegExp;

export type BlockMatcher = (ref: string) => boolean;

export type AssetKind = "module" | "classic" | "style" | "file";

export type RefOutcome = AssetKind | "remote" | "blocked" | "dynamic" | "missing" | "explicit" | "left-out" | "unsupported";

export interface DiscoverOverride {
	name?: string;
	file?: string;
	kind?: AssetKind;
	skip?: boolean;
}

export interface DiscoverOptions {
	templates: string[];
	roots: Record<string, string>;
	extensions?: string[];
	asIs?: AssetRule[];
	overrides?: Record<string, DiscoverOverride>;
}

export interface ExplicitEntries {
	scripts?: Record<string, string>;
	classicScripts?: Record<string, string>;
	files?: Record<string, string>;
	styles?: Record<string, string[]>;
	rewrite?: Record<string, string>;
}

export interface DiscoverInput extends DiscoverOptions {
	explicit?: ExplicitEntries;
	isBlocked?: BlockMatcher;
	remote?: boolean;
	cwd?: string;
}

export interface DiscoveredRef {
	ref: string;
	outcome: RefOutcome;
	tag: "script" | "link";
	templates: string[];
	name?: string;
	file?: string;
	reason?: string;
}

export type RemoteKind = "script" | "style";

export interface RemoteRef {
	ref: string;
	url: string;
	kind: RemoteKind;
	integrity?: string;
}

export interface Discovery {
	scripts: Record<string, string>;
	classicScripts: Record<string, string>;
	files: Record<string, string>;
	styles: Record<string, string[]>;
	rewrite: Record<string, string>;
	remote: RemoteRef[];
	refs: DiscoveredRef[];
	skipped: DiscoveredRef[];
}

export interface RemoteOptions {
	lockfile?: string;
	cacheDir?: string;
	maxBytes?: number;
	timeoutMs?: number;
	maxRedirects?: number;
	hosts?: AssetRule[];
	pin?: boolean;
	allowLoopbackHttp?: boolean;
	allowPrivate?: boolean;
}

export interface RemotePolicy extends RemoteOptions {
	lookup?: (host: string) => Promise<string[]>;
	now?: () => Date;
}

export interface RemotePin {
	sha384: string;
	size: number;
	type: string;
	pinned: string;
}

export interface RemoteLock {
	version: 1;
	pins: Record<string, RemotePin>;
}

export interface RemoteFetched {
	url: string;
	finalUrl: string;
	body: Uint8Array;
	type: string;
	sha384: string;
}

export interface RemoteAsset {
	ref: string;
	url: string;
	kind: RemoteKind;
	file: string;
	body: string;
	type: string;
	sha384: string;
	integrity: string;
	fromCache: boolean;
}

export interface RemoteResult {
	assets: RemoteAsset[];
	lock: RemoteLock;
	pinned: string[];
	fetched: number;
}

export interface MediaType {
	type: string;
	binary: boolean;
	compress: boolean;
}

export type AssetBody = string | Uint8Array;

export interface HeldAsset {
	body: AssetBody;
	type: string;
}

export interface CssUrlOptions {
	resolve: (target: string) => string | undefined;
	base?: string;
}

export interface MountChunk {
	selector: string;
	chunk: string;
}

export interface ChunkGraph {
	imports: Record<string, string[]>;
	mounts: Record<string, MountChunk[]>;
}

export interface BundleMeta {
	inputs: Record<string, { imports: Array<{ path: string; kind: string; original?: string; entryPoint?: string }> }>;
	outputs: Record<string, { entryPoint?: string; imports?: Array<{ path: string; kind: string }> }>;
}

export interface MountSiteSource {
	selector: string;
	from: string;
	module: string;
}

export interface ChunkGraphInput {
	meta: BundleMeta;
	sites: MountSiteSource[];
	publicPath: string;
}

export interface PrefetchChunksOptions {
	max?: number;
}

export interface ChunkManifest {
	i: Record<string, string[]>;
	m: Record<string, Array<[selector: string, chunk: string]>>;
}

export interface FirstLoadOptions {
	inline?: boolean | { maxBytes?: number };
	preload?: boolean;
	cookie?: string;
}

export interface StylePolicy {
	allowed: boolean;
	nonce?: string;
}

export interface CriticalInput {
	publicPath: string;
	maxBytes: number;
	body: (url: string) => string | undefined;
	style: StylePolicy;
	warm: boolean;
}

export interface CriticalPass {
	apply(text: string): string;
	readonly inlined: readonly string[];
	readonly bytes: number;
}

export interface WarmSignal {
	warm: boolean;
	setCookie?: string;
}

export type HeadAttributes = Record<string, string | boolean | undefined>;

export interface HeadTag {
	tag: "link" | "meta" | "script";
	attributes: HeadAttributes;
}

export interface HeadTags {
	link(attributes: HeadAttributes): HeadTags;
	meta(attributes: HeadAttributes): HeadTags;
	script(attributes: HeadAttributes): HeadTags;
	preload(href: string, as: string, attributes?: HeadAttributes): HeadTags;
	modulepreload(href: string): HeadTags;
	list(): HeadTag[];
}

export interface HeadRenderOptions {
	nonce?: string;
	present?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PrebuiltOptions {
	manifest?: string;
	strict?: boolean;
}

export interface PrebuiltFile {
	file: string;
	type: string;
	bytes: number;
	sha256: string;
	br?: number;
	gzip?: number;
}

export interface PrebuiltManifest {
	version: 1;
	natsu: string;
	fingerprint: string;
	buildId: string;
	entries: Record<string, string>;
	files: PrebuiltFile[];
	state: JsonValue;
	discovery?: Discovery;
}

export interface PrebuiltInput {
	natsu: string;
	fingerprint: string;
	buildId: string;
	entries: Record<string, string>;
	files: Array<{ file: string; body: AssetBody; type: string; br?: Uint8Array; gzip?: Uint8Array }>;
	state: JsonValue;
	discovery?: Discovery;
	manifest?: string;
}

export interface PrebuiltExpect {
	natsu: string;
	fingerprint: string;
	typeOf: (file: string) => string | undefined;
	manifest?: string;
	maxFiles?: number;
	maxBytes?: number;
}

export interface LoadedFile {
	body: AssetBody;
	type: string;
	br?: Uint8Array;
	gzip?: Uint8Array;
}

export type PrebuiltFailure = "missing" | "unreadable" | "version" | "fingerprint" | "shape" | "path" | "type" | "size" | "hash" | "limit";

export type PrebuiltLoad =
	| { ok: true; manifest: PrebuiltManifest; files: Map<string, LoadedFile> }
	| { ok: false; reason: PrebuiltFailure; detail: string };

export interface PrebuildResult {
	manifest: string;
	files: number;
	bytes: number;
	remote?: { fetched: number; pinned: string[] };
	skipped?: DiscoveredRef[];
}

export interface PrebuildTarget {
	prebuild(options?: { pin?: boolean }): Promise<PrebuildResult>;
}

export interface CliDeps {
	create: (options: unknown) => PrebuildTarget;
	load?: (path: string) => Promise<Record<string, unknown>>;
	out?: (line: string) => void;
	err?: (line: string) => void;
	cwd?: string;
}

export interface MangleScriptOptions {
	literals?: boolean;
	readable?: boolean;
}

export interface AssetPipelineOptions {
	discover?: DiscoverOptions;
	block?: AssetRule[];
	remote?: boolean | RemoteOptions;
	prebuilt?: boolean | PrebuiltOptions;
	firstLoad?: FirstLoadOptions;
	prefetchChunks?: boolean | PrefetchChunksOptions;
}
