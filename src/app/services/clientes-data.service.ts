import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { ClientesLoadResult } from '../models/cliente.model';
import { parseClientesFromXml } from '../helpers/clientes-xml.helper';

@Injectable({
  providedIn: 'root'
})
export class ClientesDataService {
  private readonly xmlStorageKey = 'clientesXmlContent';
  private readonly xmlStorageTimestampKey = 'clientesXmlUpdatedAt';
  private readonly xmlStorageFileNameKey = 'clientesXmlFileName';

  constructor(private http: HttpClient) {}

  loadClientes(): Observable<ClientesLoadResult> {
    const storedResult = this.getStoredXmlResult();
    if (storedResult) {
      return of(storedResult);
    }

    const xmlUrl = `assets/clientes.xml?v=${Date.now()}`;
    return this.http.get(xmlUrl, { responseType: 'text' }).pipe(
      map(xmlText => this.createLoadResult(xmlText, new Date(), 'clientes.xml (padrão)'))
    );
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