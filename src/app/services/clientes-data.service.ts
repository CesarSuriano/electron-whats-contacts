import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

import { ClientesLoadResult } from '../models/cliente.model';
import { parseClientesFromXml } from '../helpers/clientes-xml.helper';

@Injectable({
  providedIn: 'root'
})
export class ClientesDataService {
  private readonly xmlStorageKey = 'clientesXmlContent';
  private readonly xmlStorageTimestampKey = 'clientesXmlUpdatedAt';
  private readonly xmlStorageFileNameKey = 'clientesXmlFileName';

  loadClientes(): Observable<ClientesLoadResult> {
    const storedXmlResult = this.getStoredXmlResult();
    if (storedXmlResult) {
      return of(storedXmlResult);
    }

    return of({
      clientes: [],
      loadedAt: new Date(),
      fileName: null
    });
  }

  saveUploadedXml(fileName: string, xmlContent: string): ClientesLoadResult {
    const result = this.createLoadResult(xmlContent, new Date(), fileName);

    if (this.hasLocalStorage()) {
      localStorage.setItem(this.xmlStorageKey, xmlContent);
      localStorage.setItem(this.xmlStorageFileNameKey, fileName);
      localStorage.setItem(this.xmlStorageTimestampKey, result.loadedAt.toISOString());
    }

    return result;
  }

  clearStoredXml(): void {
    if (!this.hasLocalStorage()) {
      return;
    }

    this.clearLegacyXmlStorage();
  }

  private clearLegacyXmlStorage(): void {
    if (!this.hasLocalStorage()) {
      return;
    }

    localStorage.removeItem(this.xmlStorageKey);
    localStorage.removeItem(this.xmlStorageFileNameKey);
    localStorage.removeItem(this.xmlStorageTimestampKey);
  }

  private getStoredXmlResult(): ClientesLoadResult | null {
    if (!this.hasLocalStorage()) {
      return null;
    }

    const storedXml = localStorage.getItem(this.xmlStorageKey);
    if (!storedXml) {
      return null;
    }

    const storedTimestamp = localStorage.getItem(this.xmlStorageTimestampKey);
    const storedFileName = localStorage.getItem(this.xmlStorageFileNameKey);
    const loadedAt = storedTimestamp ? new Date(storedTimestamp) : new Date();

    try {
      return this.createLoadResult(storedXml, loadedAt, storedFileName);
    } catch (error) {
      console.error('Erro ao processar XML salvo localmente', error);
      this.clearStoredXml();
      return null;
    }
  }

  private createLoadResult(xmlContent: string, loadedAt: Date, fileName: string | null): ClientesLoadResult {
    return {
      clientes: parseClientesFromXml(xmlContent),
      loadedAt,
      fileName
    };
  }

  private hasLocalStorage(): boolean {
    return typeof localStorage !== 'undefined';
  }
}