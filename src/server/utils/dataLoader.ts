import log from 'loglevel';
import { headers as nextHeaders } from 'next/headers';
import { cache } from 'react';

import { ApiErrors, DataLoaderOptions, NeosData, OptionalOption, SiteData } from '../../types';
import ApiError from './ApiError';

log.setDefaultLevel(log.levels.DEBUG);

export const loadDocumentProps = async (
  params: { slug: string | string[] },
  opts?: DataLoaderOptions & OptionalOption
) => {
  const apiUrl = process.env.NEOS_BASE_URL;
  if (!apiUrl && opts?.optional) {
    return undefined;
  }
  if (!apiUrl) {
    throw new Error('Missing NEOS_BASE_URL environment variable');
  }

  const { slug } = params;

  if (typeof slug !== 'string' && !Array.isArray(slug)) {
    throw new Error('Missing slug param');
  }

  const path = '/' + (slug && Array.isArray(slug) ? slug.join('/') : slug);

  const startTime = Date.now();
  const fetchUrl = apiUrl + '/neos/content-api/document?path=' + encodeURIComponent(path);

  log.debug('fetching data from content API from URL', fetchUrl);

  const response = await fetch(fetchUrl, {
    headers: buildNeosHeaders(),
    cache: opts?.cache ?? 'no-store',
    next: opts?.next,
  });

  if (!response.ok) {
    if (response.status === 404) {
      log.debug('content API returned 404 for path', path);

      return undefined;
    }

    await handleNotOkResponse(response, fetchUrl);
  }

  const data: NeosData = await response.json();
  const endTime = Date.now();
  log.debug('fetched data from content API for path', path, ', took', `${endTime - startTime}ms`);

  return data;
};

export const loadPreviewDocumentProps = async (
  searchParams: { [key: string]: string | string[] | undefined },
  opts?: DataLoaderOptions & OptionalOption
) => {
  const apiUrl = process.env.NEOS_BASE_URL;
  if (!apiUrl && opts?.optional) {
    return undefined;
  }
  if (!apiUrl) {
    throw new Error('Missing NEOS_BASE_URL environment variable');
  }

  const contextPath = searchParams['node[__contextNodePath]'];
  if (typeof contextPath !== 'string') {
    throw new Error('Missing context path query parameter');
  }

  const startTime = Date.now();
  const fetchUrl = apiUrl + '/neos/content-api/document?contextPath=' + encodeURIComponent(contextPath);
  const response = await fetch(fetchUrl, {
    headers: buildNeosPreviewHeaders(),
    cache: 'no-store',
  });

  if (!response.ok) {
    if (response.status === 404) {
      log.debug('content API returned 404 for context path', contextPath);

      return undefined;
    }

    await handleNotOkResponse(response, fetchUrl);
  }

  const data: NeosData = await response.json();
  const endTime = Date.now();
  log.debug('fetched data from content API for context path', contextPath, ', took', `${endTime - startTime}ms`);

  return data;
};

async function handleNotOkResponse(response: Response, fetchUrl: string): Promise<never> {
  try {
    const data: ApiErrors = await response.json();
    if (data.errors) {
      throw new ApiError('Content API responded with errors', response.status, fetchUrl, data.errors);
    }
  } catch (e) {
    // Ignore any error if response is not JSON
  }

  throw new ApiError(
    'Content API responded with unexpected error',
    response.status,
    fetchUrl,
    undefined,
    await response.text()
  );
}

export const loadDocumentPropsCached = cache(
  (routePath: string | undefined, opts?: DataLoaderOptions & OptionalOption) => {
    if (!routePath) {
      return undefined;
    }
    log.debug('fetching data from Neos inside cache with route path', routePath);
    const slug = routePath.split('/').filter((s) => s.length > 0);
    return loadDocumentProps({ slug }, opts);
  }
);

export const loadPreviewDocumentPropsCached = cache(
  (contextNodePath: string | undefined, opts?: DataLoaderOptions & OptionalOption) => {
    if (!contextNodePath) {
      return undefined;
    }
    log.debug('fetching data from Neos inside cache with context node path', contextNodePath);
    const searchParams = { 'node[__contextNodePath]': contextNodePath };
    return loadPreviewDocumentProps(searchParams, opts);
  }
);

export const buildNeosHeaders = () => {
  const headers: Record<string, string> = {};

  // If PUBLIC_BASE_URL is set, we set the X-Forwarded-* headers from it
  if (process.env.PUBLIC_BASE_URL) {
    applyProxyHeaders(headers, process.env.PUBLIC_BASE_URL);
  }

  return headers;
};

export const loadSiteProps = async <CustomSiteData extends SiteData = SiteData>(
  opts?: DataLoaderOptions & OptionalOption
) => {
  const apiUrl = process.env.NEOS_BASE_URL;
  if (!apiUrl && opts?.optional) {
    return undefined;
  }
  if (!apiUrl) {
    throw new Error('Missing NEOS_BASE_URL environment variable');
  }

  const startTime = Date.now();
  const fetchUrl = apiUrl + '/neos/content-api/site';

  log.debug('fetching data from content API from URL', fetchUrl);

  const response = await fetch(fetchUrl, {
    headers: buildNeosHeaders(),
    cache: opts?.cache ?? 'no-store',
    next: opts?.next,
  });

  if (!response.ok) {
    const data: ApiErrors = await response.json();
    if (data.errors) {
      const flatErrors = data.errors.map((e) => e.message).join(', ');
      log.error('error fetching from content API with url', fetchUrl, ':', flatErrors);
      throw new Error('Content API responded with error: ' + flatErrors);
    }
  }

  const data: CustomSiteData = await response.json();
  const endTime = Date.now();
  log.debug('fetched data from content API with url', fetchUrl, ', took', `${endTime - startTime}ms`);

  return data;
};

export const buildNeosPreviewHeaders = () => {
  const _headers = nextHeaders();

  const headers: HeadersInit = {
    // Pass the cookie to headless API to forward the Neos session
    Cookie: _headers.get('cookie') ?? '',
  };

  // If PUBLIC_BASE_URL is set, we set the X-Forwarded-* headers from it
  if (process.env.PUBLIC_BASE_URL) {
    applyProxyHeaders(headers, process.env.PUBLIC_BASE_URL);
  } else {
    const _host = _headers.get('host');
    // Set forwarded host and port to make sure URIs in metadata are correct
    if (_host) {
      // Split host and port from header
      const [host, port] = _host.split(':');

      headers['X-Forwarded-Host'] = host;
      if (port) {
        headers['X-Forwarded-Port'] = port;
      } else {
        const _proto = _headers.get('x-forwarded-proto');
        // Check if HTTPS or HTTP request and set default port to make sure Neos does not use port of an internal endpoint
        headers['X-Forwarded-Port'] = _proto === 'https' ? '443' : '80';
        headers['X-Forwarded-Proto'] = typeof _proto === 'string' ? _proto : 'http';
      }
    }
  }
  return headers;
};

const applyProxyHeaders = (headers: Record<string, string>, baseUrl: string) => {
  const publicBaseUrl = new URL(baseUrl);
  headers['X-Forwarded-Host'] = publicBaseUrl.hostname;
  if (publicBaseUrl.port) {
    headers['X-Forwarded-Port'] = publicBaseUrl.port;
  } else {
    // Check if HTTPS or HTTP request and set default port to make sure Neos does not use port of an internal endpoint
    headers['X-Forwarded-Port'] = publicBaseUrl.protocol === 'https:' ? '443' : '80';
  }
  headers['X-Forwarded-Proto'] = publicBaseUrl.protocol === 'https:' ? 'https' : 'http';
};
