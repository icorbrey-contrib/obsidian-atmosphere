import { Notice, TFile } from "obsidian";
import type AtmospherePlugin from "../main";
import type { ContentFormat } from "../settings";
import { createDocument, putDocument, getPublication, markdownToLeafletContent, stripMarkdown, markdownToPcktContent, buildDocumentUrl, resolveWikilinks, getRecord, resolveHandle } from "../lib";
import { PublicationSelection, SelectPublicationModal } from "../components/selectPublicationModal";
import { parseResourceUri, type ResourceUri, } from "@atcute/lexicons";
import { SiteStandardDocument, SiteStandardPublication } from "@atcute/standard-site";
import { PubLeafletContent } from "@atcute/leaflet";
import { BlogPcktContent } from "@atcute/pckt";
import { extractFirstH1 } from "lib/markdown";

export async function publishFileAsDocument(plugin: AtmospherePlugin) {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("No active file to publish.");
		return;
	}

	if (!await plugin.checkAuth()) {
		new Notice("Must login to publish document.");
		return;
	}


	try {
		let { record, docUri } = await buildDocumentRecord(plugin, file);
		let { uri: newUri, record: storedRecord } = await createOrUpdateDocument(plugin, record, docUri);

		// pubUrl is at:// record uri or https:// for loose document
		// fetch pub if at:// so we can get the url
		// otherwise just use the url as is
		if (record.site.startsWith("https://")) {
			const documentUrl = buildDocumentUrl(record.site, newUri, storedRecord);
			await updateFrontMatter(plugin, file, newUri, storedRecord, documentUrl);
			return;
		}
		const pub = await getPublication(plugin.client, record.site as ResourceUri);
		const documentUrl = buildDocumentUrl(pub.value.url, newUri, storedRecord);

		await updateFrontMatter(plugin, file, newUri, storedRecord, documentUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`Error publishing document: ${message}`);
		console.error("Publish document error:", error);
	}
}

function normalizePath(raw: unknown): string | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutLeading = trimmed.replace(/^\/+/, "");
	return withoutLeading || undefined;
}

async function updateFrontMatter(
	plugin: AtmospherePlugin,
	file: TFile,
	docUri: ResourceUri,
	record: SiteStandardDocument.Main,
	documentUrl?: string
) {
	await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		const hadDocument = fm["atDocument"] !== undefined;
		fm["atDocument"] = docUri;
		fm["atPublication"] = record.site;
		fm["publishedAt"] = record.publishedAt;
		fm["updatedAt"] = new Date().toISOString();
		fm["title"] = record.title;
		if (documentUrl) {
			fm["url"] = documentUrl;
		}
		if (record.description) {
			fm["description"] = record.description;
		}
		if (record.path) {
			fm["path"] = record.path;
		}
		if (record.tags) {
			fm["tags"] = record.tags;
		}
		if (record.bskyPostRef?.uri) {
			fm["bskyPostRef"] = record.bskyPostRef.uri;
		} else if (
			plugin.settings.publish.autoInsertBskyPostRef
			&& !hadDocument
			&& fm["bskyPostRef"] === undefined
		) {
			fm["bskyPostRef"] = "";
		}
	});
}

function normalizeFormat(raw: unknown): ContentFormat | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "leaflet" || trimmed === "pckt" || trimmed === "plaintext") {
		return trimmed;
	}
	return undefined;
}


async function buildDocumentRecord(plugin: AtmospherePlugin, file: TFile): Promise<{ record: SiteStandardDocument.Main; docUri?: ResourceUri }> {
	const full = await plugin.app.vault.read(file);

	let fm: Record<string, unknown> | null = null;
	await plugin.app.fileManager.processFrontMatter(file, (fmm: Record<string, unknown>) => {
		fm = fmm;
	});
	let content = full.replace(/---\n[\s\S]*?\n---\n/, '').trim();


	let docUri: ResourceUri | undefined;
	let pubUri: ResourceUri | undefined;
	let description: string | undefined;
	let title: string | undefined;
	let path: string | undefined;
	let tags: string[] | undefined;
	let publishedAt: string | undefined;
	let format: ContentFormat | undefined;
	let bskyPostRef: { uri: string } | undefined;
	if (fm) {
		pubUri = fm["atPublication"];
		docUri = fm["atDocument"] as ResourceUri;
		description = fm["description"];
		title = fm["title"];
		path = normalizePath(fm["path"]);
		tags = fm["tags"] && Array.isArray(fm["tags"]) ? fm["tags"] : undefined;
		publishedAt = fm["publishedAt"]; // Preserve existing if updating
	}
	format = normalizeFormat(fm?.["format"]);
	bskyPostRef = await resolveBlueskyPostRef(plugin, fm?.["bskyPostRef"]);

	if (!title && plugin.settings.publish.useFirstHeaderAsTitle) {
		title = extractFirstH1(content);
	}

	if (!title) {
		title = file.basename;
	}

	let pub: SiteStandardPublication.Main | null = null;
	if (!pubUri) {
		const sel = await selectPublication(plugin);
		pubUri = sel.uri;
		pub = sel.publication;
	} else {
		const pubData = await getPublication(plugin.client, pubUri);
		pub = pubData.value;
	}

	if (!pubUri) {
		throw new Error("Missing publication URI.");
	}

	const resolved = resolveWikilinks(content, plugin.app);

	// TODO: determine which lexicon to use for rich content
	// for now just check url
	let textContent = stripMarkdown(resolved);

	let richContent: PubLeafletContent.Main | BlogPcktContent.Main | null = null;
	const publicationFormat = pubUri ? normalizeFormat(plugin.settings.publicationFormats?.[pubUri]) : undefined;
	let contentFormat: ContentFormat = "plaintext";
	if (pub?.url.contains("leaflet.pub")) {
		contentFormat = "leaflet";
	} else if (pub?.url.contains("pckt.blog")) {
		contentFormat = "pckt";
	} else {
		contentFormat = format ?? publicationFormat ?? "plaintext";
	}

	if (contentFormat === "leaflet") {
		richContent = await markdownToLeafletContent(resolved);
	} else if (contentFormat === "pckt") {
		richContent = markdownToPcktContent(resolved);
	}

	let record = {
		$type: "site.standard.document",
		title: title,
		site: pubUri,
		publishedAt,
		description: description,
		path: path,
		tags: tags,
		textContent,
		content: richContent ?? undefined,
		bskyPostRef,
	} as SiteStandardDocument.Main;
	return { record, docUri };
};

async function selectPublication(plugin: AtmospherePlugin): Promise<PublicationSelection> {
	return new Promise<PublicationSelection>((resolve, reject) => {
		let selected = false;
		const modal = new SelectPublicationModal(plugin, (selection) => {
			selected = true;
			resolve(selection);
		});

		// Override close to reject if nothing selected
		const originalClose = modal.close.bind(modal);
		modal.close = () => {
			originalClose();
			if (!selected) {
				reject(new Error("Publication not selected"));
			}
		};

		modal.open();
	});
}


async function createOrUpdateDocument(
	plugin: AtmospherePlugin,
	doc: SiteStandardDocument.Main,
	existingUri?: ResourceUri,
) {
	if (!await plugin.checkAuth()) {
		throw new Error("Client not initialized");
	}

	const recordToStore = existingUri
		? (await mergeWithExistingRecord(plugin, existingUri, doc)) ?? doc
		: doc;

	const response = existingUri
		? await putDocument(plugin.client, plugin.settings.did!, existingUri, recordToStore)
		: await createDocument(plugin.client, plugin.settings.did!, recordToStore);

	if (!response.ok) {
		throw new Error(`Failed to publish: ${response.status}`);
	}

	new Notice(`Published ${recordToStore.title}!`);
	return { uri: response.data.uri, record: recordToStore };
}

async function resolveBlueskyPostRef(
	plugin: AtmospherePlugin,
	raw: unknown
): Promise<{ uri: string } | undefined> {
	if (typeof raw !== "string") {
		return undefined;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.startsWith("at://")) {
		return { uri: trimmed };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Invalid bskyPostRef URL.");
	}

	if (!url.hostname.endsWith("bsky.app")) {
		throw new Error("Invalid bskyPostRef URL.");
	}

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[0] !== "profile" || parts[2] !== "post") {
		throw new Error("Invalid bskyPostRef URL.");
	}

	const actor = decodeURIComponent(parts[1] ?? "");
	const rkey = decodeURIComponent(parts[3] ?? "");
	if (!actor || !rkey) {
		throw new Error("Invalid bskyPostRef URL.");
	}

	let did = actor;
	if (!actor.startsWith("did:")) {
		const response = await resolveHandle(plugin.client, actor);
		if (!response.ok || !response.data?.did) {
			throw new Error("Unable to resolve bskyPostRef handle.");
		}
		did = response.data.did;
	}

	return { uri: `at://${did}/app.bsky.feed.post/${rkey}` };
}

async function mergeWithExistingRecord(
	plugin: AtmospherePlugin,
	existingUri: ResourceUri,
	nextRecord: SiteStandardDocument.Main
): Promise<SiteStandardDocument.Main | null> {
	const parsed = parseResourceUri(existingUri);
	if (!parsed.ok || !parsed.value.rkey) {
		return null;
	}

	const response = await getRecord(
		plugin.client,
		parsed.value.repo,
		parsed.value.collection,
		parsed.value.rkey
	);

	if (!response.ok || !response.data?.value || typeof response.data.value !== "object") {
		return null;
	}

	const existingValue = response.data.value as Record<string, unknown>;
	const nextValue = stripUndefined(nextRecord as unknown as Record<string, unknown>);
	return { ...existingValue, ...nextValue } as SiteStandardDocument.Main;
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined)
	);
}
