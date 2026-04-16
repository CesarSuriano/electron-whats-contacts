import { HttpClientTestingModule } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';

import { AppComponent } from './app.component';
import { ClientesTableComponent } from './components/clientes-table/clientes-table.component';
import { MessageTemplateModalComponent } from './components/message-template-modal/message-template-modal.component';
import { UploadXmlModalComponent } from './components/upload-xml-modal/upload-xml-modal.component';
import { AboutModalComponent } from './components/about-modal/about-modal.component';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        RouterTestingModule,
        HttpClientTestingModule,
        FormsModule
      ],
      declarations: [
        AppComponent,
        ClientesTableComponent,
        MessageTemplateModalComponent,
        UploadXmlModalComponent,
        AboutModalComponent
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
