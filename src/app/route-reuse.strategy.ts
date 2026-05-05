import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

/**
 * Mantém vivos componentes de rotas "pesadas" entre navegações. Sem isso, o
 * Angular destrói o componente do WhatsApp toda vez que o usuário troca pra
 * Home/Agente — perdendo a sessão WS, recarregando contatos e às vezes
 * esquecendo etiquetas que estavam carregadas.
 *
 * Rotas listadas em `cachedPaths` ficam em cache durante a vida do app.
 * Demais rotas mantêm o comportamento padrão (criadas/destruídas a cada
 * navegação).
 */
export class CacheRouteReuseStrategy implements RouteReuseStrategy {
  private readonly cache = new Map<string, DetachedRouteHandle>();
  private readonly cachedPaths = new Set<string>(['whatsapp']);

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.shouldCache(route);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.getPath(route);
    if (!key || !this.shouldCache(route)) {
      return;
    }
    if (handle) {
      this.cache.set(key, handle);
    } else {
      this.cache.delete(key);
    }
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.getPath(route);
    return Boolean(key) && this.cache.has(key);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.getPath(route);
    if (!key) {
      return null;
    }
    return this.cache.get(key) ?? null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  private shouldCache(route: ActivatedRouteSnapshot): boolean {
    const path = this.getPath(route);
    return Boolean(path) && this.cachedPaths.has(path);
  }

  private getPath(route: ActivatedRouteSnapshot): string {
    return route.routeConfig?.path?.trim() || '';
  }
}
