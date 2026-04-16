import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AboutModalComponent } from '../../components/about-modal/about-modal.component';
import { ClientesTableComponent } from '../../components/clientes-table/clientes-table.component';
import { UploadXmlModalComponent } from '../../components/upload-xml-modal/upload-xml-modal.component';
import { SharedModule } from '../shared/shared.module';
import { HomeComponent } from './home.component';
import { HomeRoutingModule } from './home-routing.module';

@NgModule({
  declarations: [
    HomeComponent,
    ClientesTableComponent,
    UploadXmlModalComponent,
    AboutModalComponent
  ],
  imports: [CommonModule, FormsModule, HttpClientModule, HomeRoutingModule, SharedModule]
})
export class HomeModule {}
