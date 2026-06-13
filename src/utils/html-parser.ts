export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractCrumbsDataRaw(html: string): string {
  const metaDataMatch = html.match(
    /<meta[^>]*id=["']js-crumbs-data["'][^>]*data-crumbs=["']([^"']+)["'][^>]*>/i
  );
  if (metaDataMatch?.[1]) {
    return decodeHtmlEntities(metaDataMatch[1]);
  }

  const looseDataMatch = html.match(
    /id=["']js-crumbs-data["'][\s\S]{0,240}?data-crumbs=["']([^"']+)["']/i
  );
  if (looseDataMatch?.[1]) {
    return decodeHtmlEntities(looseDataMatch[1]);
  }

  return '';
}

export function extractMutationCrumbsMapFromText(html: string): Record<string, string> {
  const raw = extractCrumbsDataRaw(html);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const out: Record<string, string> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
      const normalizedKey = String(key || '').trim();
      const normalizedValue = String(value ?? '').trim();
      if (normalizedKey && normalizedValue) {
        out[normalizedKey] = normalizedValue;
      }
    });
    return out;
  } catch {
    return {};
  }
}

export function extractFanIdFromText(html: string): string | null {
  const attrMatch = html.match(/data-fan-id=["'](\d+)["']/i);
  if (attrMatch?.[1]) {
    return attrMatch[1];
  }

  const scriptMatch = html.match(/(?:FanData|fan_data)\D+id\D+(\d{4,})/i);
  if (scriptMatch?.[1]) {
    return scriptMatch[1];
  }

  return null;
}

export function extractViewerFanIdFromText(html: string): string | null {
  const source = String(html || '');
  if (!source) {
    return null;
  }

  const directPatterns = [
    /(?:viewer_fan_id|viewerFanId|current_fan_id|currentFanId)["']?\s*[:=]\s*["']?(\d{4,})/i,
    /(?:Identities|PageData|pagedata)[\s\S]{0,800}?(?:current_fan_id|currentFanId|viewer_fan_id|viewerFanId)["']?\s*[:=]\s*["']?(\d{4,})/i
  ];
  for (const pattern of directPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const nestedRoots = ['current_fan', 'currentFan', 'fan_data', 'FanData', 'CurrentFan'];
  const nestedKeys = ['fan_id', 'fanId', 'fanid', 'id', 'user_id', 'userId'];
  for (const root of nestedRoots) {
    for (const key of nestedKeys) {
      const pattern = new RegExp(`${root}[\\s\\S]{0,240}?${key}["']?\\s*[:=]\\s*["']?(\\d{4,})`, 'i');
      const match = source.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return null;
}

export function extractMutationCrumbFromText(html: string, endpointPath?: string): string | null {
  const crumbMap = extractMutationCrumbsMapFromText(html);
  if (Object.keys(crumbMap).length > 0) {
    const endpointKey = String(endpointPath || '').trim().replace(/^\//, '');
    if (endpointKey) {
      const endpointCrumb = String(crumbMap[endpointKey] || crumbMap[`/${endpointKey}`] || '').trim();
      if (endpointCrumb) {
        return endpointCrumb;
      }
    }
    const generic = String(
      crumbMap['crumb'] || crumbMap['bc_page'] || crumbMap['global'] || crumbMap['bc_crumb'] || ''
    ).trim();
    if (generic) {
      return generic;
    }
  }

  const dataAttr = html.match(/data-crumb=["']([^"']+)["']/i);
  if (dataAttr?.[1]) {
    return decodeHtmlEntities(dataAttr[1]);
  }

  const inputMatch = html.match(/name=["']crumb["']\s+value=["']([^"']+)["']/i);
  if (inputMatch?.[1]) {
    return decodeHtmlEntities(inputMatch[1]);
  }

  return null;
}
