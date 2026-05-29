#!/usr/bin/env node
/**
 * 新华保险产品信息披露页面爬虫
 * 页面: https://www.newchinalife.com/info/4596
 * 共790个产品，79页
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const BASE_URL = 'https://www.newchinalife.com';
const DISCLOSURE_URL = 'https://www.newchinalife.com/info/4596';
const OUTPUT_DIR = '/Users/wenshuping/Documents/OCR_insurance/crawled/新华保险';
const TOTAL_PAGES = 79;
const PRODUCTS_PER_PAGE = 10;

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function crawlDisclosurePage(pageNum) {
  const url = `${DISCLOSURE_URL}?page=${pageNum}`;
  console.log(`\n爬取第 ${pageNum}/${TOTAL_PAGES} 页...`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await delay(1000);

    // 等待产品列表加载
    await page.waitForSelector('table', { timeout: 10000 }).catch(() => null);

    // 获取所有产品行
    const products = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const result = [];

      rows.forEach((row, index) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          const productName = cells[1]?.textContent?.trim() || '';
          const category = cells[2]?.textContent?.trim() || '';
          const status = cells[3]?.textContent?.trim() || '';

          // 查找披露材料链接
          const links = [];
          const dropdown = cells[4]?.querySelector('a');
          if (dropdown) {
            const dropdownId = dropdown.getAttribute('id') || `dropdown-${index}`;
            // 点击下拉菜单获取选项
            links.push({ type: 'dropdown', id: dropdownId });
          }

          result.push({ productName, category, status, links });
        }
      });

      return result;
    });

    console.log(`  第${pageNum}页: 找到 ${products.length} 个产品`);
    return products;

  } catch (error) {
    console.error(`  第${pageNum}页爬取失败:`, error.message);
    return [];
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('新华保险产品信息披露页面爬虫');
  console.log('='.repeat(60));
  console.log(`产品总数: 790个`);
  console.log(`页面总数: ${TOTAL_PAGES}页`);
  console.log(`输出目录: ${OUTPUT_DIR}`);
  console.log('='.repeat(60));

  // 确保输出目录存在
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const allProducts = [];

  // 爬取所有页面
  for (let page = 1; page <= TOTAL_PAGES; page++) {
    const products = await crawlDisclosurePage(page);
    allProducts.push(...products);

    // 每页间隔2秒
    if (page < TOTAL_PAGES) {
      await delay(2000);
    }
  }

  // 保存完整产品列表
  const outputFile = path.join(OUTPUT_DIR, 'disclosure_products.json');
  fs.writeFileSync(outputFile, JSON.stringify(allProducts, null, 2), 'utf-8');

  console.log('\n' + '='.repeat(60));
  console.log('爬取完成!');
  console.log('='.repeat(60));
  console.log(`总产品数: ${allProducts.length}`);
  console.log(`已保存到: ${outputFile}`);

  // 统计
  const categories = {};
  allProducts.forEach(p => {
    categories[p.category] = (categories[p.category] || 0) + 1;
  });

  console.log('\n产品分类统计:');
  Object.entries(categories).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}个`);
  });
}

main().catch(console.error);
