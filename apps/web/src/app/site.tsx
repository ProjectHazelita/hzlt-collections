import type { Site } from '@hcl/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import defaultLogo from '../assets/logo.svg';
import { useAuth } from './api';

const defaults: Site = {
  title: 'hzlt!Collections',
  description: '一个属于社群的内容分享空间。',
  logoUrl: null,
  logoAssetId: null,
  registrationOpen: true,
};
interface SiteContextValue {
  site: Site;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
}
const SiteContext = createContext<SiteContextValue | null>(null);
export function SiteProvider({ children }: { children: ReactNode }) {
  const { request } = useAuth();
  const query = useQuery({
    queryKey: ['site'],
    queryFn: ({ signal }) => request<Site>('/api/v1/site', { signal }),
  });
  const site = query.data ?? defaults;
  useEffect(() => {
    document.title = site.title;
    let description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!description) {
      description = document.createElement('meta');
      description.name = 'description';
      document.head.append(description);
    }
    description.content = site.description;
  }, [site.title, site.description]);
  useEffect(() => {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.append(icon);
    }
    icon.href = site.logoUrl || defaultLogo;
  }, [site.logoUrl]);
  return (
    <SiteContext.Provider
      value={{
        site,
        loading: query.isPending,
        error: query.error,
        refresh: async () => {
          await query.refetch();
        },
      }}
    >
      {children}
    </SiteContext.Provider>
  );
}
export function useSite(): SiteContextValue {
  const context = useContext(SiteContext);
  if (!context) throw new Error('SiteProvider is required');
  return context;
}
