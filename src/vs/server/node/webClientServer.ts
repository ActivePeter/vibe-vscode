/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, promises } from 'fs';
import type * as http from 'http';
import * as cookie from 'cookie';
import * as crypto from 'crypto';
import { isEqualOrParent } from '../../base/common/extpath.js';
import { getMediaMime } from '../../base/common/mime.js';
import { isLinux } from '../../base/common/platform.js';
import { ILogService, LogLevel } from '../../platform/log/common/log.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { extname, dirname, join, normalize, posix, resolve } from '../../base/common/path.js';
import { FileAccess, connectionTokenCookieName, connectionTokenQueryName, Schemas, builtinExtensionsPath } from '../../base/common/network.js';
import { generateUuid } from '../../base/common/uuid.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { ServerConnectionToken, ServerConnectionTokenType } from './serverConnectionToken.js';
import { asTextOrError, IRequestService } from '../../platform/request/common/request.js';
import { IHeaders } from '../../base/parts/request/common/request.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { URI } from '../../base/common/uri.js';
import { streamToBuffer } from '../../base/common/buffer.js';
import { IProductConfiguration } from '../../base/common/product.js';
import { isString, Mutable } from '../../base/common/types.js';
import { CharCode } from '../../base/common/charCode.js';
import { IExtensionManifest } from '../../platform/extensions/common/extensions.js';
import { ITranslations, localizeManifest } from '../../platform/extensionManagement/common/extensionNls.js';
import { ICSSDevelopmentService } from '../../platform/cssDev/node/cssDevService.js';
import { webClientCacheDirectory } from '../../platform/remote/common/webClientCache.js';
import { IWebClientStartupConfiguration, IWebClientStartupMessages } from '../../platform/remote/common/webClientStartup.js';

const textMimeType: { [ext: string]: string | undefined } = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
};

/**
 * Return an error to the client.
 */
export async function serveError(req: http.IncomingMessage, res: http.ServerResponse, errorCode: number, errorMessage: string): Promise<void> {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

export const enum CacheControl {
	NO_CACHING, ETAG, NO_EXPIRY
}

/** Orders supported compressed representations, respecting explicit refusals and quality values. */
export function getWebClientPreferredEncodings(acceptEncoding: string | undefined): readonly ('br' | 'gzip')[] {
	const qualities = new Map<string, number>();
	for (const part of acceptEncoding?.split(',') ?? []) {
		const [encoding, ...parameters] = part.trim().toLowerCase().split(';');
		const qualityParameter = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
		const quality = qualityParameter ? Number(qualityParameter.substring(2)) : 1;
		qualities.set(encoding.trim(), Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
	}
	const quality = (encoding: string) => qualities.get(encoding) ?? qualities.get('*') ?? 0;
	return (['br', 'gzip'] as const).filter(encoding => quality(encoding) > 0).sort((first, second) => quality(second) - quality(first));
}

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(filePath: string, cacheControl: CacheControl, logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, responseHeaders: Record<string, string>, precompressed = false): Promise<void> {
	try {
		let stat = await promises.stat(filePath); // throws an error if the original doesn't exist
		let representationPath = filePath;
		// Only immutable releases have build-time representations. A developer editing a source file
		// must never receive an older sidecar, nor may mutable workspace files opt into this path.
		if (precompressed) {
			responseHeaders['Vary'] = responseHeaders['Vary'] ? `${responseHeaders['Vary']}, Accept-Encoding` : 'Accept-Encoding';
			for (const encoding of getWebClientPreferredEncodings(req.headers['accept-encoding'])) {
				const candidate = `${filePath}.${encoding === 'br' ? 'br' : 'gz'}`;
				try {
					const candidateStat = await promises.stat(candidate);
					if (candidateStat.isFile()) {
						representationPath = candidate;
						stat = candidateStat;
						responseHeaders['Content-Encoding'] = encoding;
						break;
					}
				} catch (error) {
					if (error.code !== 'ENOENT') {
						throw error;
					}
				}
			}
			responseHeaders['Content-Length'] = String(stat.size);
		}
		if (cacheControl === CacheControl.ETAG) {

			// Check if file modified since
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			responseHeaders['Etag'] = etag;
			if (req.headers['if-none-match'] === etag) {
				res.writeHead(304, responseHeaders);
				return void res.end();
			}
		} else if (cacheControl === CacheControl.NO_EXPIRY) {
			responseHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
		} else if (cacheControl === CacheControl.NO_CACHING) {
			responseHeaders['Cache-Control'] = 'no-store';
		}

		responseHeaders['Content-Type'] = textMimeType[extname(filePath)] || getMediaMime(filePath) || 'text/plain';

		// Create the stream first and wait for it to open before sending
		// headers so that errors (e.g. ENOENT race) can still produce a
		// proper 404 response instead of aborting a half-sent 200.
		const fileStream = createReadStream(representationPath);
		await new Promise<void>((resolve, reject) => {
			fileStream.on('error', reject);
			fileStream.on('open', () => {
				// File opened successfully - send headers and pipe
				res.writeHead(200, responseHeaders);
				fileStream.pipe(res);
				// Destroy the read stream if the response is closed prematurely
				// (e.g. client disconnect) to avoid leaking the file descriptor.
				res.once('close', () => fileStream.destroy());
				fileStream.on('end', resolve);
				// Replace the initial error handler now that headers are sent
				fileStream.removeAllListeners('error');
				fileStream.on('error', error => {
					logService.error(error);
					console.error(error.toString());
					res.destroy();
				});
			});
		});
	} catch (error) {
		if (error.code !== 'ENOENT') {
			logService.error(error);
			console.error(error.toString());
		} else {
			console.error(`File not found: ${filePath}`);
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return void res.end('Not found');
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri('').fsPath);

const STATIC_PATH = `/static`;
const CALLBACK_PATH = `/callback`;
const WEB_EXTENSION_PATH = `/web-extension-resource`;
const VIBE_VSCODE_BUILTIN_WEB_EXTENSION_PATH = 'vibe-vscode';

export function getWebClientStaticAssetRoute(cacheVersion: string | undefined): string {
	if (!cacheVersion) {
		return STATIC_PATH;
	}

	const cacheKey = crypto.createHash('sha256').update(cacheVersion).digest('hex');
	return `${STATIC_PATH}/${cacheKey}`;
}

export function getWebClientStaticAssetCacheControl(isBuilt: boolean, cacheVersion: string | undefined): CacheControl {
	return isBuilt || !!cacheVersion ? CacheControl.NO_EXPIRY : CacheControl.ETAG;
}

export interface IWebClientStartupTemplate {
	readonly style: string;
	readonly body: string;
	readonly script: string;
}

const WORKBENCH_STARTUP_STYLE_MARKER = '<!-- WORKBENCH_STARTUP_STYLE -->';
const WORKBENCH_STARTUP_BODY_MARKER = '<!-- WORKBENCH_STARTUP_BODY -->';
const WORKBENCH_STARTUP_SCRIPT_MARKER = '<!-- WORKBENCH_STARTUP_SCRIPT -->';

/**
 * Splits the shared startup fragment into the three locations required by the workbench document.
 */
export function parseWebClientStartupTemplate(content: string): IWebClientStartupTemplate {
	const styleMarkerIndex = content.indexOf(WORKBENCH_STARTUP_STYLE_MARKER);
	const bodyMarkerIndex = content.indexOf(WORKBENCH_STARTUP_BODY_MARKER);
	const scriptMarkerIndex = content.indexOf(WORKBENCH_STARTUP_SCRIPT_MARKER);
	if (styleMarkerIndex === -1 || bodyMarkerIndex <= styleMarkerIndex || scriptMarkerIndex <= bodyMarkerIndex) {
		throw new Error('Invalid workbench startup template.');
	}

	const getSection = (start: number, marker: string, end: number): string => {
		let section = content.substring(start + marker.length, end);
		if (section.startsWith('\r\n')) {
			section = section.substring(2);
		} else if (section.startsWith('\n')) {
			section = section.substring(1);
		}
		return section.trimEnd();
	};

	return {
		style: getSection(styleMarkerIndex, WORKBENCH_STARTUP_STYLE_MARKER, bodyMarkerIndex),
		body: getSection(bodyMarkerIndex, WORKBENCH_STARTUP_BODY_MARKER, scriptMarkerIndex),
		script: getSection(scriptMarkerIndex, WORKBENCH_STARTUP_SCRIPT_MARKER, content.length),
	};
}

/** Reads startup data before workbench NLS is available, with safe locale and English fallbacks. */
export async function getWebClientStartupConfiguration(locale: string, staticRoot: string, resourceCacheAvailable = false): Promise<IWebClientStartupConfiguration> {
	const requested = locale.split(';', 1)[0].trim().toLowerCase();
	const normalized = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requested) ? requested : 'en';
	const locales = new Set<string>();
	for (let candidate = normalized; candidate;) {
		if (candidate === 'zh') {
			locales.add(/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(normalized) ? 'zh-hant' : 'zh-hans');
		}
		locales.add(candidate);
		const separator = candidate.lastIndexOf('-');
		candidate = separator === -1 ? '' : candidate.substring(0, separator);
	}
	locales.add('en');
	for (const candidate of locales) {
		try {
			const file = FileAccess.asFileUri(`vs/platform/remote/common/workbench-startup.nls.${candidate}.json`).fsPath;
			const messages: IWebClientStartupMessages = JSON.parse(await promises.readFile(file, 'utf8'));
			return {
				resourceCache: resourceCacheAvailable ? posix.join(staticRoot, 'out', webClientCacheDirectory, 'manifest.json') : undefined,
				messages,
			};
		} catch (error) {
			if (error.code !== 'ENOENT' || candidate === 'en') {
				throw error;
			}
		}
	}
	throw new Error('The default workbench startup messages are missing.');
}

/** Returns package NLS bundles from the most specific safe locale to the default bundle. */
export function getBuiltinExtensionPackageNLSCandidates(locale: string): readonly string[] {
	const requestedLocale = locale.split(';', 1)[0].trim().toLowerCase();
	const normalizedLocale = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedLocale) ? requestedLocale : 'en';
	const localeCandidates: string[] = [];
	for (let candidate = normalizedLocale; candidate && candidate !== 'en' && !candidate.startsWith('en-');) {
		localeCandidates.push(`package.nls.${candidate}.json`);
		const separator = candidate.lastIndexOf('-');
		candidate = separator === -1 ? '' : candidate.substring(0, separator);
	}
	localeCandidates.push('package.nls.json');
	return localeCandidates;
}

/** Returns the public HTTP scheme supplied by a trusted reverse proxy. */
export function getWebClientResourceScheme(forwardedProto: string | undefined): 'http' | 'https' {
	const publicScheme = forwardedProto?.split(',', 1)[0].trim().toLowerCase();
	return publicScheme === Schemas.https ? Schemas.https : Schemas.http;
}

async function readBuiltinExtensionPackageNLS(extensionPath: string, locale: string): Promise<ITranslations> {
	for (const candidate of getBuiltinExtensionPackageNLSCandidates(locale)) {
		try {
			const resource = FileAccess.asFileUri(`${builtinExtensionsPath}/${extensionPath}/${candidate}`).fsPath;
			return JSON.parse((await promises.readFile(resource)).toString());
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}
	return {};
}

export class WebClientServer {

	private readonly _webExtensionResourceUrlTemplate: URI | undefined;
	private readonly _cacheVersion: string | undefined;
	private readonly _staticAssetRoute: string;
	private readonly _staticAssetCacheControl: CacheControl;
	private readonly _resourceCacheAvailable: Promise<boolean>;

	constructor(
		private readonly _connectionToken: ServerConnectionToken,
		private readonly _basePath: string,
		private readonly _productPath: string,
		private readonly _remoteConnectionSigning: boolean,
		probeResourceCache: () => Promise<boolean> = () => promises.stat(FileAccess.asFileUri(`${webClientCacheDirectory}/manifest.json`).fsPath).then(stat => stat.isFile(), () => false),
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
		@ICSSDevelopmentService private readonly _cssDevService: ICSSDevelopmentService
	) {
		this._webExtensionResourceUrlTemplate = this._productService.extensionsGallery?.resourceUrlTemplate ? URI.parse(this._productService.extensionsGallery.resourceUrlTemplate) : undefined;
		this._cacheVersion = this._environmentService.args['web-client-cache-version'];
		this._staticAssetRoute = getWebClientStaticAssetRoute(this._cacheVersion);
		this._staticAssetCacheControl = getWebClientStaticAssetCacheControl(this._environmentService.isBuilt, this._cacheVersion);
		this._resourceCacheAvailable = this._cacheVersion
			? probeResourceCache()
			: Promise.resolve(false);
	}

	/**
	 * Handle web resources (i.e. only needed by the web client).
	 * **NOTE**: This method is only invoked when the server has web bits.
	 * **NOTE**: This method is only invoked after the connection token has been validated.
	 * @param parsedUrl The URL to handle, including base and product path
	 * @param pathname The pathname of the URL, without base and product path
	 */
	async handle(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL, pathname: string): Promise<void> {
		try {
			if (pathname.startsWith(this._staticAssetRoute) && pathname.charCodeAt(this._staticAssetRoute.length) === CharCode.Slash) {
				return this._handleStatic(req, res, pathname.substring(this._staticAssetRoute.length));
			}
			if (pathname === '/') {
				return this._handleRoot(req, res, parsedUrl);
			}
			if (pathname === CALLBACK_PATH) {
				// callback support
				return this._handleCallback(res);
			}
			if (pathname.startsWith(WEB_EXTENSION_PATH) && pathname.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash) {
				// extension resource support
				return this._handleWebExtensionResource(req, res, pathname.substring(WEB_EXTENSION_PATH.length));
			}

			return serveError(req, res, 404, 'Not found.');
		} catch (error) {
			this._logService.error(error);
			console.error(error.toString());

			return serveError(req, res, 500, 'Internal Server Error.');
		}
	}
	/**
	 * Handle HTTP requests for /static/*
	 * @param resourcePath The path after /static/
	 */
	private async _handleStatic(req: http.IncomingMessage, res: http.ServerResponse, resourcePath: string): Promise<void> {
		const headers: Record<string, string> = Object.create(null);

		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)

		const filePath = join(APP_ROOT, normalizedPathname); // join also normalizes the path
		if (!isEqualOrParent(filePath, APP_ROOT, !isLinux)) {
			return serveError(req, res, 400, `Bad request.`);
		}

		return serveFile(filePath, this._staticAssetCacheControl, this._logService, req, res, headers, !!this._cacheVersion);
	}

	private _getResourceURLTemplateAuthority(uri: URI): string | undefined {
		const index = uri.authority.indexOf('.');
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

	/**
	 * Handle extension resources
	 * @param resourcePath The path after /web-extension-resource/
	 */
	private async _handleWebExtensionResource(req: http.IncomingMessage, res: http.ServerResponse, resourcePath: string): Promise<void> {
		if (!this._webExtensionResourceUrlTemplate) {
			return serveError(req, res, 500, 'No extension gallery service configured.');
		}

		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)
		const path = normalize(normalizedPathname);
		const uri = URI.parse(path).with({
			scheme: this._webExtensionResourceUrlTemplate.scheme,
			authority: path.substring(0, path.indexOf('/')),
			path: path.substring(path.indexOf('/') + 1)
		});

		if (this._getResourceURLTemplateAuthority(this._webExtensionResourceUrlTemplate) !== this._getResourceURLTemplateAuthority(uri)) {
			return serveError(req, res, 403, 'Request Forbidden');
		}

		const headers: IHeaders = {};
		const setRequestHeader = (header: string) => {
			const value = req.headers[header];
			if (value && (isString(value) || value[0])) {
				headers[header] = isString(value) ? value : value[0];
			} else if (header !== header.toLowerCase()) {
				setRequestHeader(header.toLowerCase());
			}
		};
		setRequestHeader('X-Client-Name');
		setRequestHeader('X-Client-Version');
		setRequestHeader('X-Machine-Id');
		setRequestHeader('X-Client-Commit');

		const context = await this._requestService.request({
			type: 'GET',
			url: uri.toString(true),
			headers,
			callSite: 'webClientServer.fetchAndWriteFile'
		}, CancellationToken.None);

		const status = context.res.statusCode || 500;
		if (status !== 200) {
			let text: string | null = null;
			try {
				text = await asTextOrError(context);
			} catch (error) {/* Ignore */ }
			return serveError(req, res, status, text || `Request failed with status ${status}`);
		}

		const responseHeaders: Record<string, string | string[]> = Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (value) {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader('Cache-Control');
		setResponseHeader('Content-Type');
		res.writeHead(200, responseHeaders);
		const buffer = await streamToBuffer(context.stream);
		return void res.end(buffer.buffer);
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL): Promise<void> {

		const getFirstHeader = (headerName: string) => {
			const val = req.headers[headerName];
			return Array.isArray(val) ? val[0] : val;
		};

		// Prefix routes with basePath for clients
		const basePath = getFirstHeader('x-forwarded-prefix') || this._basePath;

		const queryConnectionTokens = parsedUrl.searchParams.getAll(connectionTokenQueryName);
		if (queryConnectionTokens.length === 1) {
			const queryConnectionToken = queryConnectionTokens[0];
			// We got a connection token as a query parameter.
			// We want to have a clean URL, so we strip it
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				queryConnectionToken,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);

			const newQuery = new URLSearchParams(parsedUrl.searchParams);
			newQuery.delete(connectionTokenQueryName);
			const queryString = newQuery.toString();
			const newLocation = queryString ? `${basePath}?${queryString}` : basePath;
			responseHeaders['Location'] = newLocation;

			res.writeHead(302, responseHeaders);
			return void res.end();
		}

		const replacePort = (host: string, port: string) => {
			const index = host?.indexOf(':');
			if (index !== -1) {
				host = host?.substring(0, index);
			}
			host += `:${port}`;
			return host;
		};

		const useTestResolver = (!this._environmentService.isBuilt && this._environmentService.args['use-test-resolver']);
		let remoteAuthority = (
			useTestResolver
				? 'test+test'
				: (getFirstHeader('x-original-host') || getFirstHeader('x-forwarded-host') || req.headers.host)
		);
		if (!remoteAuthority) {
			return serveError(req, res, 400, `Bad request.`);
		}
		const forwardedPort = getFirstHeader('x-forwarded-port');
		if (forwardedPort) {
			remoteAuthority = replacePort(remoteAuthority, forwardedPort);
		}

		function asJSON(value: unknown): string {
			return JSON.stringify(value)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.args['enable-smoke-test-driver']) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		if (this._logService.getLevel() === LogLevel.Trace) {
			['x-original-host', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'host'].forEach(header => {
				const value = getFirstHeader(header);
				if (value) {
					this._logService.trace(`[WebClientServer] ${header}: ${value}`);
				}
			});
			this._logService.trace(`[WebClientServer] Request URL: ${req.url}, basePath: ${basePath}, remoteAuthority: ${remoteAuthority}`);
		}

		const staticRoute = posix.join(basePath, this._productPath, this._staticAssetRoute);
		const callbackRoute = posix.join(basePath, this._productPath, CALLBACK_PATH);
		const webExtensionRoute = posix.join(basePath, this._productPath, WEB_EXTENSION_PATH);

		const resolveWorkspaceURI = (defaultLocation?: string) => defaultLocation && URI.file(resolve(defaultLocation)).with({ scheme: Schemas.vscodeRemote, authority: remoteAuthority });

		const filePath = FileAccess.asFileUri(`vs/code/browser/workbench/workbench${this._environmentService.isBuilt ? '' : '-dev'}.html`).fsPath;
		const startupFilePath = FileAccess.asFileUri('vs/code/browser/workbench/workbench-startup.html').fsPath;
		const authSessionInfo = !this._environmentService.isBuilt && this._environmentService.args['github-auth'] ? {
			id: generateUuid(),
			providerId: 'github',
			accessToken: this._environmentService.args['github-auth'],
			scopes: [['user:email'], ['repo']]
		} : undefined;

		const productConfiguration: Partial<Mutable<IProductConfiguration>> = {
			embedderIdentifier: 'server-distro',
			remoteConnectionSigning: this._remoteConnectionSigning,
			voiceWsUrl: this._productService.voiceWsUrl,
			extensionsGallery: this._webExtensionResourceUrlTemplate && this._productService.extensionsGallery ? {
				...this._productService.extensionsGallery,
				resourceUrlTemplate: this._webExtensionResourceUrlTemplate.with({
					scheme: getWebClientResourceScheme(getFirstHeader('x-forwarded-proto')),
					authority: remoteAuthority,
					path: `${webExtensionRoute}/${this._webExtensionResourceUrlTemplate.authority}${this._webExtensionResourceUrlTemplate.path}`
				}).toString(true)
			} : undefined
		};

		if (!this._environmentService.isBuilt) {
			try {
				const productOverrides = JSON.parse((await promises.readFile(join(APP_ROOT, 'product.overrides.json'))).toString());
				Object.assign(productConfiguration, productOverrides);
			} catch (err) {/* Ignore Error */ }
		}

		const workbenchWebConfiguration = {
			remoteAuthority,
			serverBasePath: basePath,
			_wrapWebWorkerExtHostInIframe,
			developmentOptions: { enableSmokeTestDriver: this._environmentService.args['enable-smoke-test-driver'] ? true : undefined, logLevel: this._logService.getLevel() },
			settingsSyncOptions: !this._environmentService.isBuilt && this._environmentService.args['enable-sync'] ? { enabled: true } : undefined,
			enableWorkspaceTrust: !this._environmentService.args['disable-workspace-trust'],
			enabledExtensionProposedApi: this._environmentService.args['enable-proposed-api'],
			folderUri: resolveWorkspaceURI(this._environmentService.args['default-folder']),
			workspaceUri: resolveWorkspaceURI(this._environmentService.args['default-workspace']),
			productConfiguration,
			callbackRoute: callbackRoute
		};

		const cookies = cookie.parse(req.headers.cookie || '');
		const locale = cookies['vscode.nls.locale'] || req.headers['accept-language']?.split(',')[0]?.toLowerCase() || 'en';
		let WORKBENCH_NLS_BASE_URL: string | undefined;
		let WORKBENCH_NLS_URL: string;
		if (!locale.startsWith('en') && this._productService.nlsCoreBaseUrl) {
			WORKBENCH_NLS_BASE_URL = this._productService.nlsCoreBaseUrl;
			WORKBENCH_NLS_URL = `${WORKBENCH_NLS_BASE_URL}${this._productService.commit}/${this._productService.version}/${locale}/nls.messages.js`;
		} else {
			WORKBENCH_NLS_URL = ''; // fallback will apply
		}
		const startupConfiguration = await getWebClientStartupConfiguration(locale, staticRoute, await this._resourceCacheAvailable);

		const values: { [key: string]: string } = {
			WORKBENCH_WEB_CONFIGURATION: asJSON(workbenchWebConfiguration),
			WORKBENCH_AUTH_SESSION: authSessionInfo ? asJSON(authSessionInfo) : '',
			WORKBENCH_STARTUP_CONFIGURATION: asJSON(startupConfiguration),
			WORKBENCH_WEB_BASE_URL: staticRoute,
			WORKBENCH_MAIN_SCRIPT_TYPE: startupConfiguration.resourceCache ? 'application/json' : 'module',
			WORKBENCH_NLS_URL,
			WORKBENCH_NLS_FALLBACK_URL: `${staticRoute}/out/nls.messages.js`
		};

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: The server needs to send along all CSS modules so that the client can construct the
		// DEV: import-map.
		// DEV ---------------------------------------------------------------------------------------
		if (this._cssDevService.isEnabled) {
			const cssModules = await this._cssDevService.getCssModules();
			values['WORKBENCH_DEV_CSS_MODULES'] = JSON.stringify(cssModules);
		}

		if (!this._environmentService.isBuilt) {
			const vibeVscodePackageJSON: IExtensionManifest = JSON.parse((await promises.readFile(FileAccess.asFileUri(`${builtinExtensionsPath}/${VIBE_VSCODE_BUILTIN_WEB_EXTENSION_PATH}/package.json`).fsPath)).toString());
			const vibeVscodeDefaultPackageNLS = await readBuiltinExtensionPackageNLS(VIBE_VSCODE_BUILTIN_WEB_EXTENSION_PATH, 'en');
			const vibeVscodeLocalizedPackageNLS = await readBuiltinExtensionPackageNLS(VIBE_VSCODE_BUILTIN_WEB_EXTENSION_PATH, locale);
			const bundledExtensions: { extensionPath: string; packageJSON: IExtensionManifest; packageNLS?: Record<string, string> }[] = [{
				extensionPath: VIBE_VSCODE_BUILTIN_WEB_EXTENSION_PATH,
				packageJSON: localizeManifest(this._logService, vibeVscodePackageJSON, vibeVscodeLocalizedPackageNLS, vibeVscodeDefaultPackageNLS),
			}];
			for (const extensionPath of useTestResolver ? ['vscode-test-resolver', 'github-authentication'] : []) {
				const packageJSON = JSON.parse((await promises.readFile(FileAccess.asFileUri(`${builtinExtensionsPath}/${extensionPath}/package.json`).fsPath)).toString());
				bundledExtensions.push({ extensionPath, packageJSON });
			}
			values['WORKBENCH_BUILTIN_EXTENSIONS'] = asJSON(bundledExtensions);
		}

		let data: string;
		try {
			const [workbenchTemplate, startupTemplate] = await Promise.all([
				promises.readFile(filePath, 'utf8'),
				promises.readFile(startupFilePath, 'utf8')
			]);
			const renderTemplate = (template: string) => template.replace(/\{\{([^}]+)\}\}/g, (_, key) => values[key] ?? 'undefined');
			const startup = parseWebClientStartupTemplate(startupTemplate);
			values['WORKBENCH_STARTUP_STYLE'] = renderTemplate(startup.style);
			values['WORKBENCH_STARTUP_BODY'] = renderTemplate(startup.body);
			values['WORKBENCH_STARTUP_SCRIPT'] = renderTemplate(startup.script);
			data = renderTemplate(workbenchTemplate);
		} catch (e) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			return void res.end('Not found');
		}

		const webWorkerExtensionHostIframeScriptSHA = 'sha256-daEgfo2VIXpx2Np71KqCCbkeQwv+68vPrx54XRcbdcs=';

		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'self\';',
			`script-src 'self' 'unsafe-eval' ${WORKBENCH_NLS_BASE_URL ?? ''} blob: 'nonce-1nline-m4p' ${this._getScriptCspHashes(data).join(' ')} '${webWorkerExtensionHostIframeScriptSHA}' 'sha256-/r7rqQ+yrxt57sxLuQ6AMYcy/lUpvAIzHjIJt/OeLWU=' ${useTestResolver ? '' : `http://${remoteAuthority}`};`,  // the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
			'child-src \'self\';',
			`frame-src 'self' https://*.vscode-cdn.net data:;`,
			'worker-src \'self\' data: blob:;',
			'style-src \'self\' \'unsafe-inline\';',
			'connect-src \'self\' ws: wss: https:;',
			`font-src 'self' blob:${startupConfiguration.resourceCache ? ' data:' : ''};`,
			'manifest-src \'self\';'
		].join(' ');

		const headers: http.OutgoingHttpHeaders = {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		};
		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			headers['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				this._connectionToken.value,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);
		}

		res.writeHead(200, headers);
		return void res.end(data);
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script>([\s\S]+?)<\/script>/img;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while (match = regex.exec(content)) {
			const hasher = crypto.createHash('sha256');
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[1].replace(/\r\n/g, '\n');
			const hash = hasher
				.update(Buffer.from(script))
				.digest().toString('base64');

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	private async _handleCallback(res: http.ServerResponse): Promise<void> {
		const filePath = FileAccess.asFileUri('vs/code/browser/workbench/callback.html').fsPath;
		const data = (await promises.readFile(filePath)).toString();
		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'none\';',
			`script-src 'self' ${this._getScriptCspHashes(data).join(' ')};`,
			'style-src \'self\' \'unsafe-inline\';',
			'font-src \'self\' blob:;'
		].join(' ');

		res.writeHead(200, {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		});
		return void res.end(data);
	}
}
