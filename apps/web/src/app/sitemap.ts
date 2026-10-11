import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';

const PATHS = ['', '/support', '/privacy', '/terms', '/delete-account'];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${site.origin}${p}` }));
}
