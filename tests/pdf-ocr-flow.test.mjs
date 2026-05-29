import assert from 'node:assert/strict';
import test from 'node:test';
import { jsPDF } from 'jspdf';
import { scanInsurancePolicyLocal } from '../ocr-service/insurance-ocr.service.mjs';

test('text-based PDF upload extracts policy text for field parsing', async () => {
  const pdf = new jsPDF();
  pdf.setFont('helvetica');
  pdf.setFontSize(16);
  pdf.text('Xinhua Insurance whole life insurance', 10, 20);
  pdf.text('Basic amount: 100000 yuan', 10, 35);
  pdf.text('Payment period: 10 years', 10, 50);
  const dataUrl = pdf.output('datauristring');

  const scan = await scanInsurancePolicyLocal({
    ocrText: '',
    uploadItem: {
      name: 'policy.pdf',
      type: 'application/pdf',
      size: dataUrl.length,
      dataUrl,
    },
  });

  assert.match(scan.ocrText, /100000/);
  assert.equal(Number(scan.data.amount), 100000);
});
