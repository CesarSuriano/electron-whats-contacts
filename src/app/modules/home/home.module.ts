import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ClientesTableComponent } from '../../components/clientes-table/clientes-table.component';
import { UploadXmlModalComponent } from '../../components/upload-xml-modal/upload-xml-modal.component';
import { SharedModule } from '../shared/shared.module';
import { HomeDashboardSectionComponent } from './components/home-dashboard-section/home-dashboard-section.component';
import { HomeComponent } from './home.component';
import { HomeRoutingModule } from './home-routing.module';

@NgModule({
  declarations: [
    HomeComponent,
    HomeDashboardSectionComponent,
    ClientesTableComponent,
    UploadXmlModalComponent
  ],
  imports: [CommonModule, FormsModule, HomeRoutingModule, SharedModule]
})
export class HomeModule {}
