import { TestBed } from '@angular/core/testing';

import { ClientesDataService } from './clientes-data.service';

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientes>
  <cliente>
    <razao_social>Teste</razao_social>
    <cpf>000.000.000-00</cpf>
    <data_cadastro>2023-01-01</data_cadastro>
    <data_nascimento>1990-06-15</data_nascimento>
  </cliente>
</clientes>`;

describe('ClientesDataService', () => {
  let service: ClientesDataService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [ClientesDataService]
    });
    service = TestBed.inject(ClientesDataService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('loadClientes', () => {
    it('returns an empty result when no imported clients exist yet', () => {
      let result: any;
      service.loadClientes().subscribe(r => (result = r));

      expect(result.clientes).toEqual([]);
      expect(result.fileName).toBeNull();
    });

    it('returns cached XML result from localStorage when present', () => {
      localStorage.setItem('clientesXmlContent', MINIMAL_XML);
      localStorage.setItem('clientesXmlFileName', 'clientes-importados.xml');
      localStorage.setItem('clientesXmlUpdatedAt', new Date().toISOString());

      let result: any;
      service.loadClientes().subscribe(r => (result = r));

      expect(result.clientes.length).toBe(1);
      expect(result.fileName).toBe('clientes-importados.xml');
      expect(result.clientes[0].nome).toBe('Teste');
    });

    it('clears invalid XML data from localStorage', () => {
      localStorage.setItem('clientesXmlContent', 'INVALID <<< XML');
      localStorage.setItem('clientesXmlFileName', 'bad.xml');

      let result: any;
      service.loadClientes().subscribe(r => (result = r));

      expect(result.clientes).toEqual([]);
      expect(localStorage.getItem('clientesXmlContent')).toBeNull();
    });
  });

  describe('saveUploadedXml', () => {
    it('parses XML and returns a ClientesLoadResult', () => {
      const res = service.saveUploadedXml('upload.xml', MINIMAL_XML);
      expect(res.clientes.length).toBe(1);
      expect(res.fileName).toBe('upload.xml');
      expect(res.loadedAt).toBeInstanceOf(Date);
    });

    it('persists XML to localStorage', () => {
      service.saveUploadedXml('persisted.xml', MINIMAL_XML);
      expect(localStorage.getItem('clientesXmlContent')).toBe(MINIMAL_XML);
      expect(localStorage.getItem('clientesXmlFileName')).toBe('persisted.xml');
    });
  });

  describe('clearStoredXml', () => {
    it('removes legacy XML localStorage keys', () => {
      localStorage.setItem('clientesXmlContent', MINIMAL_XML);
      localStorage.setItem('clientesXmlFileName', 'test.xml');
      localStorage.setItem('clientesXmlUpdatedAt', new Date().toISOString());

      service.clearStoredXml();

      expect(localStorage.getItem('clientesXmlContent')).toBeNull();
      expect(localStorage.getItem('clientesXmlFileName')).toBeNull();
      expect(localStorage.getItem('clientesXmlUpdatedAt')).toBeNull();
    });
  });
});
