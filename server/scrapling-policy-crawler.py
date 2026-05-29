#!/usr/bin/env python3
import base64
import asyncio
import hashlib
import html as html_lib
import io
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup
from scrapling.fetchers import Fetcher

NEW_CHINA_PRODUCT_DISCLOSURE_URLS = [
    "https://www.newchinalife.com/info/4596",
    "https://www.newchinalife.com/info/3279_23",
]
CHINA_LIFE_PRODUCT_INFO_ENDPOINT = "https://www.e-chinalife.com/jw/web/json/app/product_info_publish/plugin/com.chinalife.yunque.ProductInfoPublish/service"
CHINA_LIFE_OFFICIAL_BASE_URL = "https://www.e-chinalife.com/"
CHINA_UNITED_LIFE_OFFICIAL_BASE_URL = "https://life.cic.cn/"
CHINA_UNITED_LIFE_PRODUCT_INFO_ENDPOINT = "https://life.cic.cn/productInfo/query"
CHINA_UNITED_LIFE_OFFICIAL_DOMAINS = {"life.cic.cn", "faos-static-prd.life.cic.cn", "static.life.cic.cn"}
CHINA_UNITED_LIFE_PRODUCT_PROFILES = [
    {
        "prop": "I",
        "status": "0",
        "label": "在售个人产品",
        "salesStatus": "在售",
        "sourcePage": "https://life.cic.cn/redirect/344498052988188.html",
        "sourceGroup": "product-info",
    },
    {
        "prop": "G",
        "status": "0",
        "label": "在售团体产品",
        "salesStatus": "在售",
        "sourcePage": "https://life.cic.cn/redirect/344526499972918.html",
        "sourceGroup": "product-info",
    },
    {
        "prop": "I",
        "status": "1",
        "label": "停售个人产品",
        "salesStatus": "停售",
        "sourcePage": "https://life.cic.cn/redirect/344526643210249.html",
        "sourceGroup": "product-info",
    },
    {
        "prop": "G",
        "status": "1",
        "label": "停售团体产品",
        "salesStatus": "停售",
        "sourcePage": "https://life.cic.cn/redirect/344526957195676.html",
        "sourceGroup": "product-info",
    },
    {
        "prop": "X",
        "status": "0",
        "label": "新型产品",
        "salesStatus": "在售（新型产品）",
        "sourcePage": "https://life.cic.cn/redirect/606207712627118.html",
        "sourceGroup": "new-type",
    },
]
LIAN_LIFE_OFFICIAL_BASE_URL = "https://www.lianlife.com/"
LIAN_LIFE_PRODUCT_BOX_URL = "https://www.lianlife.com/productBox"
LIAN_LIFE_PRODUCT_LIST_ENDPOINT = "https://www.lianlife.com/api/v1/boclian/pc/component/products/productInfoListPage"
LIAN_LIFE_OFFICIAL_DOMAINS = {"lianlife.com", "www.lianlife.com"}
LIAN_LIFE_PRODUCT_TYPE_CODES = ["1", "2", "3", "4", "5", "7"]
LIAN_LIFE_SALE_STATUS_MAP = {"2": "在售", "3": "停售"}
LIAN_LIFE_MATERIAL_TYPES = {
    "tk": {"label": "产品条款", "materialType": "terms"},
    "sms": {"label": "产品说明书", "materialType": "product_manual"},
}
PING_AN_PRODUCT_LIST_ENDPOINT = "https://life.pingan.com/ilife-home/product/getProductList"
PING_AN_PLAN_PDF_ENDPOINT = "https://life.pingan.com/ilife-home/product/getPlanClausePdf"
CHINA_TAIPING_WCP_BASE_URL = "https://tpwx.life.cntaiping.com/tpwcp/wcp/wcpalpha/"
CHINA_TAIPING_DISCLOSURE_URL = "https://life.cntaiping.com/info-zstscp/?source=sy"
CHINA_TAIPING_OFFICIAL_BASE_URL = "https://life.cntaiping.com/"
CHINA_TAIPING_COMPOUND_TERMS = [
    "cptk_1139_1140.html",
    "bwjnh_cptk_1187_1188.html",
    "cptk_1216_1217_1218_1219.html",
]
PICC_LIFE_OFFICIAL_BASE_URL = "https://www.picclife.com/"
PICC_LIFE_PRODUCT_PAGE_BASES = {
    "in_sale": {
        "path": "/picclifewebsite/webfile/productInformations/index.html",
        "label": "在售",
    },
    "stopped": {
        "path": "/picclifewebsite/webfile/stopProducts/index.html",
        "label": "停售",
    },
}
TAIKANG_LIFE_PRODUCT_INFO_URL = "https://www.taikanglife.com/publicinfonew/basicnew/pubproduct/commonprodinfonew/list_542_1.html"
TAIKANG_LIFE_OFFICIAL_DOMAIN = "www.taikanglife.com"
TAIKANG_LIFE_TABLES = {
    "tb_tab_1": "在售",
    "tb_tab_2": "停售",
}
SUNSHINE_LIFE_PRODUCT_INFO_URL = "https://www.sinosig.com/v/pilu?type=sx&tabIndex=10001_26"
SUNSHINE_LIFE_OFFICIAL_DOMAIN = "www.sinosig.com"
SUNSHINE_LIFE_PDF_DOMAIN = "static.sinosig.com"
GUOHUA_LIFE_PRODUCT_INFO_URL = "https://www.95549.cn/pages/intro/xxpl_detail03_1.shtml"
GUOHUA_LIFE_OFFICIAL_DOMAIN = "www.95549.cn"
HAPPY_LIFE_OFFICIAL_BASE_URL = "https://www.happyinsurance.com.cn/"
HAPPY_LIFE_OFFICIAL_DOMAIN = "www.happyinsurance.com.cn"
HAPPY_LIFE_PRODUCT_PAGES = {
    "in_sale": {
        "pattern": "https://www.happyinsurance.com.cn/info/list_25_26_{page}.html",
        "salesStatus": "在售",
    },
    "stopped": {
        "pattern": "https://www.happyinsurance.com.cn/info/list_25_27_{page}.html",
        "salesStatus": "停售",
    },
}
CAIXIN_LIFE_OFFICIAL_BASE_URL = "https://life.hnchasing.com/"
CAIXIN_LIFE_OFFICIAL_DOMAIN = "life.hnchasing.com"
CAIXIN_LIFE_PRODUCT_PAGES = {
    "in_sale": {
        "url": "https://life.hnchasing.com/disclose_product_info/for_sales/",
        "salesStatus": "在售",
    },
    "stopped": {
        "url": "https://life.hnchasing.com/disclose_product_info/halt_sales/",
        "salesStatus": "停售",
    },
}
CPIC_LIFE_OFFICIAL_BASE_URL = "https://life.cpic.com.cn/"
CPIC_LIFE_PRODUCT_CATEGORIES = [
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/zbcp/sx/index.shtml", "salesStatus": "在售", "productType": "寿险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/zbcp/nj/index.shtml", "salesStatus": "在售", "productType": "年金险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/zbcp/ywx/index.shtml", "salesStatus": "在售", "productType": "意外险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/zbcp/jkx/index.shtml", "salesStatus": "在售", "productType": "健康险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/tbcp/sx/index.shtml", "salesStatus": "停售", "productType": "寿险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/tbcp/nj/index.shtml", "salesStatus": "停售", "productType": "年金险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/tbcp/ywx/index.shtml", "salesStatus": "停售", "productType": "意外险"},
    {"path": "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/tbcp/jkx/index.shtml", "salesStatus": "停售", "productType": "健康险"},
]
CHINA_POST_LIFE_OFFICIAL_BASE_URL = "https://www.chinapost-life.com/"
CHINA_POST_LIFE_PRODUCT_LIST_PAGES = [
    {
        "url": "https://www.chinapost-life.com/publish/publish1/publish1_3/publish1_3_1/",
        "salesStatus": "在售",
    },
    {
        "url": "https://www.chinapost-life.com/publish/publish1/publish1_3/publish1_3_2/",
        "salesStatus": "停售",
    },
]
CHINA_POST_LIFE_INTERNET_PRODUCTS_URL = "https://www.chinapost-life.com/publish/publish4/publish4_1/publish4_1_5/"
CHINA_POST_LIFE_PRODUCT_CENTER_URL = "https://www.chinapost-life.com/product/product1/"
CMRH_LIFE_OFFICIAL_BASE_URL = "https://www.cmrh.com/"
CMRH_LIFE_PRODUCT_INFO_URL = "https://www.cmrh.com/html/informationDisclosure.shtml?menuName=%E5%9F%BA%E6%9C%AC%E4%BF%A1%E6%81%AF"
CMRH_LIFE_PRODUCT_LIST_ENDPOINT = "https://www.cmrh.com/official-mg-app/openapi/v1/product/pageList"
CMRH_LIFE_PRODUCT_STATUS_OPTIONS = {
    "ON_SALE": "在售",
    "SALE_END": "停售",
}
AEON_LIFE_OFFICIAL_BASE_URL = "https://www.aeonlife.com.cn/"
AEON_LIFE_PRODUCT_INFO_URL = "https://www.aeonlife.com.cn/product/information/index.shtml"
AEON_LIFE_PRODUCT_LIST_ENDPOINT = "https://www.aeonlife.com.cn/product/information/getProductInfoList.shtml"
AEON_LIFE_DOWNLOAD_ENDPOINT = "https://www.aeonlife.com.cn/product/information/downLoadProductInfo.shtml"
AEON_LIFE_INTERNET_DISCLOSURE_URL = "https://www.aeonlife.com.cn/info/internet/12477.shtml"
METLIFE_OFFICIAL_BASE_URL = "https://www.metlife.com.cn/"
METLIFE_PRODUCT_PAGES = {
    "available": {
        "url": "https://www.metlife.com.cn/information-disclosure/public-information-disclosure/basic-information/basic-product-information/available-products",
        "salesStatus": "在售",
    },
    "discontinued": {
        "url": "https://www.metlife.com.cn/information-disclosure/public-information-disclosure/basic-information/basic-product-information/discontinued-products",
        "salesStatus": "停售",
    },
}
METLIFE_DMTM_PAGE = {
    "url": "https://www.metlife.com.cn/information-disclosure/dmtm",
    "salesStatus": "电销披露",
}
AIA_LIFE_PRODUCT_LIST_ENDPOINT = "https://cws.aia.com.cn/mypage/productpublish/list"
AIA_LIFE_OFFICIAL_BASE_URL = "https://www.aia.com.cn/"
AIA_LIFE_PUBLIC_DISCLOSURE_DOC_BASE_URL = "https://www.aia.com.cn/content/dam/cn/zh-cn/docs/public-disclosure/"
AIA_LIFE_PRODUCT_PAGES = {
    "available": {
        "url": "https://www.aia.com.cn/zh-cn/gongkaixinxipilou/jibenxinxi/chanpinjibenxinxi/zaishouchanpin",
        "apiStatus": "在售",
        "salesStatus": "在售",
    },
    "discontinued": {
        "url": "https://www.aia.com.cn/zh-cn/gongkaixinxipilou/jibenxinxi/chanpinjibenxinxi/tingshoujiqita",
        "apiStatus": "停售及其他",
        "salesStatus": "停售及其他",
    },
}
CCB_LIFE_PRODUCT_INFO_URL = "https://www.ccb-life.com.cn/html/6182/3131/index.html"
CCB_LIFE_OFFICIAL_BASE_URL = "https://www.ccb-life.com.cn/"
CCB_LIFE_OFFICIAL_DOMAIN = "www.ccb-life.com.cn"
MINSHENG_LIFE_OFFICIAL_BASE_URL = "https://www.minshenglife.com/"
MINSHENG_LIFE_OFFICIAL_DOMAIN = "www.minshenglife.com"
MINSHENG_LIFE_PRODUCT_LIST_ENDPOINT = "https://www.minshenglife.com/api/publicinfo/productByName"
MINSHENG_LIFE_PRODUCT_CATEGORIES = [
    {
        "path": "/publicinfo/productitem/1/0",
        "onSale": True,
        "insuranceFlag": "0",
        "salesStatus": "在售个险",
    },
    {
        "path": "/publicinfo/productitem/1/1",
        "onSale": True,
        "insuranceFlag": "1",
        "salesStatus": "在售团险",
    },
    {
        "path": "/publicinfo/productitem/0/0",
        "onSale": False,
        "insuranceFlag": "0",
        "salesStatus": "停售个险",
    },
    {
        "path": "/publicinfo/productitem/0/1",
        "onSale": False,
        "insuranceFlag": "1",
        "salesStatus": "停售团险",
    },
]
CATHAY_LIFE_OFFICIAL_BASE_URL = "https://www.cathaylife.cn/"
CATHAY_LIFE_PRODUCT_PAGES = [
    {"url": "https://www.cathaylife.cn/zscpnew/index.html", "salesStatus": "在售"},
    {"url": "https://www.cathaylife.cn/tscpnew/index.html", "salesStatus": "停售（2023年7月1日后）"},
    {"url": "https://www.cathaylife.cn/lstsnew/index.html", "salesStatus": "停售（历史：2023年6月30日前）"},
]
CATHAY_LIFE_FILING_URL = "https://www.cathaylife.cn/bacpnew/index.html"
CATHAY_LIFE_TABLE_CATEGORIES = {
    1: "人寿保险",
    2: "年金保险",
    3: "健康保险",
    4: "意外保险",
}
UNION_LIFE_OFFICIAL_BASE_URL = "https://www.unionlife.com.cn/"
UNION_LIFE_OFFICIAL_DOMAIN = "www.unionlife.com.cn"
UNION_LIFE_PRODUCT_PAGES = [
    {
        "key": "product_directory",
        "url": "https://www.unionlife.com.cn/union/gkxxpl/jb/cpjbxx/cpmljtk/index.html",
        "salesStatus": "官网产品目录",
    },
    {
        "key": "in_sale",
        "url": "https://www.unionlife.com.cn/union5/c/2023-07-21/493774.html",
        "salesStatus": "在售",
    },
    {
        "key": "internet",
        "url": "https://www.unionlife.com.cn/c/2025-12-02/491370.html",
        "salesStatus": "互联网披露",
    },
    {
        "key": "directory",
        "url": "https://www.unionlife.com.cn/union5/c/2021-02-01/491347.html",
        "salesStatus": "官网目录",
    },
]
UNION_LIFE_EXCLUDED_MATERIAL_RE = re.compile(
    r"费率|费率表|现金价值|基本保险金额表|利益演示|账户价值|备案|报备|投保规则|投保须知|告知书|职业分类|清单",
    re.I,
)
BOCOMM_LIFE_OFFICIAL_BASE_URL = "https://www.bocommlife.com/"
BOCOMM_LIFE_OFFICIAL_DOMAIN = "www.bocommlife.com"
BOCOMM_LIFE_LIST_PAGES = [
    {
        "key": "in_sale",
        "baseUrl": "https://www.bocommlife.com/110425/",
        "salesStatus": "在售",
    },
    {
        "key": "stopped_after_2024",
        "baseUrl": "https://www.bocommlife.com/110431/",
        "salesStatus": "停售（2024年及之后）",
    },
]
BOCOMM_LIFE_DIRECT_TABLE_PAGES = [
    {
        "key": "product_basic_info",
        "url": "https://www.bocommlife.com/101850/index.html",
        "salesStatus": "在售（产品基本信息页）",
    },
    {
        "key": "stopped_before_2024",
        "url": "https://www.bocommlife.com/110426/index.html",
        "salesStatus": "停售（2024年之前）",
    },
]
BOCOMM_LIFE_LEGACY_STOPPED_URL = "https://www.bocommlife.com/110032/detail111436.html"
BOCOMM_LIFE_TELESALES_URL = "https://www.bocommlife.com/101875/index.html"
BOCOMM_LIFE_EXCLUDED_MATERIAL_RE = re.compile(
    r"费率|费率表|现金价值|领取转换表|转换表|利益演示|账户价值|基本保险金额|投保规则|投保须知|清单|告知书",
    re.I,
)
ICBC_AXA_PRODUCT_INFO_URL = "https://www.icbc-axa.com/public/public_base/public_base_3/publicIndex.jsp"
ICBC_AXA_OFFICIAL_BASE_URL = "https://www.icbc-axa.com/"
ICBC_AXA_OFFICIAL_DOMAIN = "www.icbc-axa.com"
ABC_LIFE_OFFICIAL_BASE_URL = "https://www.abchinalife.com/"
ABC_LIFE_OFFICIAL_DOMAIN = "www.abchinalife.com"
ABC_LIFE_PRODUCT_INFO_URL = "https://www.abchinalife.com/xxpl/jbxx/bxcpxxpl/index.shtml"
ABC_LIFE_PRODUCT_PAGES = [
    {
        "key": "main_sale",
        "group": "main",
        "kind": "table",
        "url": "https://www.abchinalife.com/xxpl/jbxx/bxcpxxpl/zsbxcpml/index.shtml",
        "salesStatus": "在售",
        "label": "在售保险产品目录",
    },
    {
        "key": "main_stop",
        "group": "main",
        "kind": "table",
        "url": "https://www.abchinalife.com/xxpl/jbxx/bxcpxxpl/tsbxcpml/index.shtml",
        "salesStatus": "停售",
        "label": "停售保险产品目录",
    },
    {
        "key": "internet_sale",
        "group": "internet",
        "kind": "direct_terms",
        "url": "https://www.abchinalife.com/xxpl/hlwbx/hlwbxcpxx/hlwbxzscp/index.shtml",
        "salesStatus": "在售",
        "label": "互联网保险在售产品",
    },
    {
        "key": "internet_stop",
        "group": "internet",
        "kind": "direct_terms",
        "url": "https://www.abchinalife.com/xxpl/hlwbx/hlwbxcpxx/hlwbxtscp/index.shtml",
        "salesStatus": "停售",
        "label": "互联网保险停售产品",
    },
    {
        "key": "manual_sale",
        "group": "manual",
        "kind": "direct_manual",
        "url": "https://www.abchinalife.com/xxpl/zxxx/xxcpsms/zscpsms/index.shtml",
        "salesStatus": "在售",
        "label": "在售产品说明书",
    },
    {
        "key": "manual_stop",
        "group": "manual",
        "kind": "direct_manual",
        "url": "https://www.abchinalife.com/xxpl/zxxx/xxcpsms/tscpsms/index.shtml",
        "salesStatus": "停售",
        "label": "停售产品说明书",
    },
]
ABC_LIFE_EXCLUDED_MATERIAL_RE = re.compile(
    r"费率|费率表|现金价值|现价|利益演示|账户价值|基本保险金额表|投保规则|投保须知|告知书|职业分类|清单|批复|备案",
    re.I,
)
AVIVA_COFCO_LIFE_OFFICIAL_BASE_URL = "https://www.aviva-cofco.com.cn/"
AVIVA_COFCO_LIFE_OFFICIAL_DOMAIN = "www.aviva-cofco.com.cn"
AVIVA_COFCO_LIFE_PRODUCT_PAGES = [
    {
        "url": "https://www.aviva-cofco.com.cn/website/xxzx/gkxxpl/gsjbxx/grbxcpxx/zscpxx/list-1.shtml",
        "salesStatus": "在售",
    },
    {
        "url": "https://www.aviva-cofco.com.cn/website/xxzx/gkxxpl/gsjbxx/grbxcpxx/tscpxx/list-1.shtml",
        "salesStatus": "停售",
    },
]
GREATWALL_LIFE_OFFICIAL_BASE_URL = "https://www.greatlife.cn/"
GREATWALL_LIFE_OFFICIAL_DOMAIN = "greatlife.cn"
GREATWALL_LIFE_PRODUCT_INFO_URL = "https://www.greatlife.cn/page/xxpl/jbxx/cpgy.shtml"
GREATWALL_LIFE_PRODUCT_PAGES = [
    {"action": "queryProDocList", "salesStatus": "在售"},
    {"action": "queryProHaltDocList", "salesStatus": "停售"},
]
GUOFU_LIFE_OFFICIAL_BASE_URL = "https://www.e-guofu.com/"
GUOFU_LIFE_OFFICIAL_DOMAIN = "e-guofu.com"
GUOFU_LIFE_PRODUCT_INFO_URL = "https://www.e-guofu.com/proInformation/index.html"
GUOFU_LIFE_PRODUCT_API = "https://www.e-guofu.com/sinocms/getCmsContentByName"
GUOFU_LIFE_PRODUCT_CATEGORIES = [
    {"key": "available", "categoryId": "118", "salesStatus": "在售", "referer": "https://www.e-guofu.com/inSaleProInfo/index.html"},
    {"key": "discontinued", "categoryId": "119", "salesStatus": "停售", "referer": "https://www.e-guofu.com/noSaleProInfo/index.html"},
]
XINTAI_LIFE_PRODUCT_INFO_URL = "https://www.xintai.com/web/info/baseInfo/productInfo/index.jsp"
XINTAI_LIFE_PRODUCT_LIST_ENDPOINT = "https://www.xintai.com/organization/findProducts.do"
XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL = "https://sinatay.com/web/info/internetInsurance/productInformation/index.jsp"
XINTAI_LIFE_OFFICIAL_BASE_URL = "https://www.xintai.com/"
XINTAI_LIFE_OFFICIAL_DOMAIN = "xintai.com"
MANULIFE_SINOCHEM_OFFICIAL_BASE_URL = "https://www.manulife-sinochem.com/"
MANULIFE_SINOCHEM_OFFICIAL_DOMAIN = "manulife-sinochem.com"
MANULIFE_SINOCHEM_PRODUCT_PAGES = {
    "current": {
        "url": "https://www.manulife-sinochem.com/business/public-information/basic/product1",
        "label": "当前产品基本信息",
    },
    "legacy": {
        "url": "https://www.manulife-sinochem.com/business/public-information/basic/product",
        "label": "历史产品基本信息",
    },
}
AEGON_THTF_PRODUCT_INFO_URL = "https://www.aegonthtf.com/gkxxpl/jbxx/cpjbxx/"
AEGON_THTF_OFFICIAL_BASE_URL = "https://www.aegonthtf.com/"
AEGON_THTF_OFFICIAL_DOMAIN = "aegonthtf.com"
AEGON_THTF_ATTACHMENT_DOMAIN = "cmsweb.aegonthtf.com"
AEGON_THTF_PRODUCT_LISTS = {
    "listArr1": {"salesStatus": "在售", "segment": "个人保险", "label": "在售产品目录：个人保险"},
    "listArr2": {"salesStatus": "在售", "segment": "团体保险", "label": "在售产品目录：团体保险"},
    "listArr3": {"salesStatus": "停售", "segment": "个人保险", "label": "停售产品目录：个人保险"},
    "listArr4": {"salesStatus": "停售", "segment": "团体保险", "label": "停售产品目录：团体保险"},
    "listArr6": {"salesStatus": "已报备未销售", "segment": "未销售", "label": "已报备未销售产品目录"},
}
SUNLIFE_EVERBRIGHT_OFFICIAL_BASE_URL = "https://www.sunlife-everbright.com/"
SUNLIFE_EVERBRIGHT_OFFICIAL_DOMAIN = "www.sunlife-everbright.com"
SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL = "https://www.sunlife-everbright.com/sleb/info/jbxx/cpjbxx/jydbxcpmljtk/609782/index.html"
SUNLIFE_EVERBRIGHT_ARCHIVE_EXCLUDED_RE = re.compile(
    r"费率|保险费率|现金价值|现价|利益演示|账户价值|材料清单|清单|报送材料|备案报送|编码信息|精算师|声明书|法律责任人|责任人|批复|批单|变更原因|对比说明|投保规则|投保须知",
    re.I,
)
GENERALI_CHINA_LIFE_OFFICIAL_BASE_URL = "https://www.generalichina.com/"
GENERALI_CHINA_LIFE_OFFICIAL_DOMAIN = "www.generalichina.com"
GENERALI_CHINA_LIFE_PRODUCT_PAGES = [
    {
        "key": "personal_in_sale",
        "url": "https://www.generalichina.com/gexianzaishou/",
        "salesStatus": "在售",
        "segment": "个人保险",
    },
    {
        "key": "personal_stopped",
        "url": "https://www.generalichina.com/gexiantingshou/",
        "salesStatus": "停售",
        "segment": "个人保险",
    },
    {
        "key": "group_in_sale",
        "url": "https://www.generalichina.com/tuanxianzaishou/",
        "salesStatus": "在售",
        "segment": "团体保险",
    },
    {
        "key": "group_stopped",
        "url": "https://www.generalichina.com/tuanxiantingshou/",
        "salesStatus": "停售",
        "segment": "团体保险",
    },
]
BOHAI_LIFE_OFFICIAL_BASE_URL = "https://www.bohailife.net/"
BOHAI_LIFE_OFFICIAL_DOMAIN = "bohailife.net"
BOHAI_LIFE_PRODUCT_INFO_URL = "https://www.bohailife.net/xxpl/jbxx/jbxx.shtml"
BOHAI_LIFE_INTERNET_DISCLOSURE_URL = "https://www.bohailife.net/zxxx/hulianwangbaoxian/bhlifewesitehulianwangbaoxiansecond.shtml"
BOHAI_LIFE_IN_SALE_PRODUCT_URL = "https://www.bohailife.net/xxpl/jbxx/zscp.shtml"
BOHAI_LIFE_STOPPED_PRODUCT_URL = "https://www.bohailife.net/xxpl/jbxx/tscp.shtml"
BOHAI_LIFE_PRODUCT_PAGES = [
    {
        "key": "product_info",
        "url": BOHAI_LIFE_PRODUCT_INFO_URL,
        "label": "产品基本信息",
        "defaultSalesStatus": "未标明",
    },
    {
        "key": "internet",
        "url": BOHAI_LIFE_INTERNET_DISCLOSURE_URL,
        "label": "互联网保险信息披露",
        "defaultSalesStatus": "互联网保险披露",
    },
    {
        "key": "in_sale_archives",
        "url": BOHAI_LIFE_IN_SALE_PRODUCT_URL,
        "label": "在售产品资料包",
        "defaultSalesStatus": "在售",
    },
    {
        "key": "stopped_archives",
        "url": BOHAI_LIFE_STOPPED_PRODUCT_URL,
        "label": "停售产品资料包",
        "defaultSalesStatus": "停售",
    },
]
RESPONSIBILITY_MATERIAL_LABELS = {"条款", "产品说明", "产品说明书"}
EXCLUDED_MATERIAL_RE = re.compile(r"近三年|通知|费率表|现金价值表|账户价值|利益演示", re.I)
RESPONSIBILITY_END_RE = re.compile(
    r"第[一二三四五六七八九十]+条\s*(?:责任免除|保险金额|基本保险金额|伤残程度鉴定|受益人|保险事故通知|保单红利|现金红利|红利|保险金申请|释义|其他事项|合同内容变更)"
    r"|责任免除|保单红利|现金红利|保险金申请"
)
BENEFIT_SECTION_END_RE = re.compile(
    r"\d+\s*[.、]\s*(?:您享有的其他重要权益|其他重要权益|保单贷款|减保)"
    r"|[（(]\s*[二三四五六七八九十]+\s*[）)]\s*(?:责任免除|主要投资策略|累积生息账户|红利|保险利益演示|现金价值)"
    r"|[二三四五六七八九十]+\s*[、.]\s*(?:红利|责任免除|保险利益演示|现金价值)"
    r"|责任免除"
)
RESPONSIBILITY_KEYWORDS = [
    "保险责任",
    "身故",
    "身体全残",
    "全残",
    "给付",
    "保险金",
    "赔付",
    "报销",
    "意外伤害",
    "交通工具",
    "重大疾病",
    "医疗",
    "津贴",
    "等待期",
    "给付系数",
    "基本保险金额",
    "有效保险金额",
    "已交保险费",
    "现金价值",
]
RESPONSIBILITY_CONTENT_RE = re.compile(
    r"给付|赔付|赔偿|报销|保险金|保险责任|承担|身故|全残|伤残|残疾|重大疾病|轻症|中症|医疗|住院|津贴|豁免|满期|生存|年金|护理|烧伤"
)
RESPONSIBILITY_ACTUAL_RE = re.compile(
    r"(?:我们|本公司|[\u4e00-\u9fff]{2,12}人寿).{0,80}(?:承担|给付|赔付|赔偿|报销).{0,80}(?:保险责任|保险金|医疗费用|津贴|保险费)"
    r"|(?:承担|给付|赔付|赔偿|报销).{0,80}(?:保险金|医疗费用|津贴|基本保险金额|有效保险金额|保险费)"
    r"|被保险人.{0,200}(?:身故|全残|伤残|残疾|疾病|医疗|住院|意外伤害|烧伤).{0,200}(?:保险金|给付|赔付|赔偿|报销|豁免)"
    r"|(?:身故|全残|伤残|残疾|疾病|医疗|住院|津贴|豁免|满期|生存|年金|护理).{0,40}保险金"
    r"|豁免保险费|遭受.{0,120}意外伤害.{0,120}保险责任"
)
RESPONSIBILITY_TOC_RE = re.compile(
    r"保险责任\s*(?:\d+\s*(?:\.\s*\d+\s*)+)?(?:"
    r"(?:保险期间(?:与\s*续保)?).{0,120}(?:我们不保什么|责任免除|其他免责条款|如何支付保险费|如何领取保险金|受益人|保险事故通知)"
    r"|(?:责任免除|其他免责条款|受益人|基本保险金额|保险金额|如何申请|如何领取|保险事故通知)"
    r")"
)
RESPONSIBILITY_TOC_MARKER_RE = re.compile(r"目\s*录|条款目录|阅读指引|阅\s*读\s*指\s*引|\.{3,}|…{2,}|……")
RESPONSIBILITY_SECTION_HEADING_RE = re.compile(
    r"保险期间|犹豫期|宽限期|合同效力|责任免除|不保什么|其他免责条款|如何申请|如何领取|保险金申请|受益人|释义|保单红利|现金价值|保险费|退保"
)
RESPONSIBILITY_POSITIVE_RE = re.compile(
    r"(?:我们|本公司).{0,80}(?<!不)(?:承担|给付|赔付|赔偿|报销).{0,100}(?:保险责任|保险金|医疗费用|津贴|保险费|基本保险金额|有效保险金额)"
    r"|(?:按|按照).{0,100}(?:给付|赔付|赔偿|报销).{0,100}(?:保险金|医疗费用|津贴|保险费|基本保险金额|有效保险金额)"
    r"|(?:承担下列|承担以下|承担如下).{0,80}保险责任"
    r"|被保险人.{0,220}(?:身故|全残|伤残|残疾|疾病|医疗|住院|意外伤害|烧伤|达到|生存).{0,220}(?:保险金|给付|赔付|赔偿|报销|豁免)"
    r"|(?:身故|全残|伤残|残疾|疾病|医疗|住院|津贴|豁免|满期|生存|年金|护理|意外).{0,50}保险金"
    r"|豁免保险费"
)
RESPONSIBILITY_NEGATIVE_RE = re.compile(r"(?:不承担|不给付|不予给付|除外责任|责任免除).{0,80}(?:保险责任|保险金|医疗费用|津贴|保险费)")
MAX_EXCERPT_CHARS = 9000
MAX_PDF_BYTES = 12_000_000
MAX_ZIP_BYTES = 80_000_000
OUTPUT_MARKER = "__POLICY_KNOWLEDGE_JSON__"
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def comparable(value: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", value or "")


def trim(value: Any) -> str:
    return str(value or "").strip()


def runtime_path(filename: str) -> str:
    return os.path.join(PROJECT_ROOT, ".runtime", filename)


def quote_url(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            quote(parts.path, safe="/%:@"),
            quote(parts.query, safe="=&%:@/?"),
            quote(parts.fragment, safe="%:@/?"),
        )
    )


def product_matches(product_name: str, value: str) -> bool:
    product = comparable(product_name)
    target = comparable(value)
    short_product = comparable(product_name.replace("（分红型）", "").replace("(分红型)", ""))
    return bool(product and target and (product in target or target in product or short_product in target))


def fetch_html(url: str) -> tuple[int, str]:
    page = Fetcher.get(url, timeout=25, impersonate="chrome")
    body = getattr(page, "body", b"") or b""
    return int(getattr(page, "status", 0) or 0), body.decode("utf-8", "ignore")


def fetch_html_direct(url: str, referer: str = "") -> tuple[int, str]:
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {referer or PICC_LIFE_OFFICIAL_BASE_URL}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, ""
    return 200, proc.stdout.decode("utf-8", "ignore")


def fetch_picc_life_html(url: str) -> tuple[int, str]:
    try:
        status, html = fetch_html(url)
        if status >= 200 and status < 300 and html:
            return status, html
    except Exception:
        pass
    return fetch_html_direct(url)


def fetch_bytes(url: str) -> tuple[int, bytes]:
    page = Fetcher.get(quote_url(url), timeout=45, impersonate="chrome")
    body = getattr(page, "body", b"") or b""
    return int(getattr(page, "status", 0) or 0), bytes(body)


def fetch_bytes_direct(url: str, referer: str = "") -> tuple[int, bytes]:
    proc = subprocess.run(
        [
            "curl",
            "-L",
            "-sS",
            "--max-time",
            "25",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {referer or PICC_LIFE_OFFICIAL_BASE_URL}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=35,
    )
    if proc.returncode != 0:
        return 0, b""
    return 200, proc.stdout[: MAX_PDF_BYTES + 1]


def fetch_binary_direct(url: str, referer: str = "", max_bytes: int = MAX_PDF_BYTES) -> tuple[int, str, bytes]:
    with tempfile.NamedTemporaryFile(prefix="policy-body-", suffix=".bin") as body_file, tempfile.NamedTemporaryFile(
        prefix="policy-headers-", suffix=".txt"
    ) as header_file:
        proc = subprocess.run(
            [
                "curl",
                "--http1.1",
                "-L",
                "-sS",
                "--max-time",
                "60",
                "--user-agent",
                "Mozilla/5.0",
                "-H",
                f"Referer: {referer or PICC_LIFE_OFFICIAL_BASE_URL}",
                "-D",
                header_file.name,
                "-o",
                body_file.name,
                quote_url(url),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=75,
        )
        data = body_file.read()
        headers = header_file.read().decode("utf-8", "ignore")
    statuses = [int(match.group(1)) for match in re.finditer(r"HTTP/\S+\s+(\d+)", headers)]
    content_types = re.findall(r"(?im)^content-type:\s*([^\r\n]+)", headers)
    status = statuses[-1] if statuses else (200 if proc.returncode == 0 else 0)
    content_type = trim(content_types[-1]) if content_types else ""
    return status, content_type, data[: max_bytes + 1]


def fetch_json(url: str) -> tuple[int, dict[str, Any]]:
    status, html = fetch_html(url)
    if status < 200 or status >= 300:
        return status, {}
    try:
        return status, json.loads(html)
    except Exception:
        return status, {}


def post_json(url: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    page = Fetcher.post(
        url,
        json=payload,
        timeout=30,
        impersonate="chrome",
        headers={
            "Content-Type": "application/json",
            "Origin": "https://life.pingan.com",
            "Referer": "https://life.pingan.com/gongkaixinxipilu/baoxianchanpinmulujitiaokuan.jsp",
        },
    )
    body = getattr(page, "body", b"") or b""
    status = int(getattr(page, "status", 0) or 0)
    try:
        return status, json.loads(body.decode("utf-8", "ignore"))
    except Exception:
        return status, {}


def extract_pdf_text_with_system_python(data: bytes) -> dict[str, Any]:
    if not data:
        return {"pages": 0, "text": ""}
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return {"pages": len(reader.pages), "text": "\n".join((page.extract_text() or "") for page in reader.pages)}
    except Exception:
        pass
    code = """
import base64, io, json, sys
try:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(base64.b64decode(sys.stdin.read())))
    print(json.dumps({"pages": len(reader.pages), "text": "\\n".join((page.extract_text() or "") for page in reader.pages)}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"pages": 0, "text": "", "error": str(error)}, ensure_ascii=False))
"""
    proc = subprocess.run(
        [sys.executable, "-c", code],
        input=base64.b64encode(data),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    try:
        return json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return {"pages": 0, "text": "", "error": proc.stderr.decode("utf-8", "ignore")[:300]}


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_responsibility_source_text(value: str) -> str:
    text = clean_text(value)
    if not text:
        return ""
    # Some PDF extractors split Chinese text into fragments such as "第 五 条 保 险 责 任".
    # Keep Latin/numeric spacing intact, but reconnect adjacent Chinese characters for rule matching.
    text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)
    text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[，,。：:；;、）)])", "", text)
    text = re.sub(r"(?<=[（(])\s+(?=[\u4e00-\u9fff])", "", text)
    return text


def html_text(value: str) -> str:
    soup = BeautifulSoup(value or "", "html.parser")
    for item in soup(["script", "style"]):
        item.decompose()
    return clean_text(soup.get_text(" ", strip=True))


def responsibility_heading_count(fragment: str) -> int:
    return len(RESPONSIBILITY_SECTION_HEADING_RE.findall(fragment))


def is_responsibility_toc_context(normalized: str, start: int) -> bool:
    before = normalized[max(0, start - 260) : start]
    near = normalized[start : start + 760]
    early = near[:420]
    heading_count = responsibility_heading_count(early)
    has_toc_marker = bool(RESPONSIBILITY_TOC_MARKER_RE.search(before[-160:] + early))
    has_positive = bool(RESPONSIBILITY_POSITIVE_RE.search(near))
    if has_toc_marker and heading_count >= 2 and not has_positive:
        return True
    if re.search(r"保险责任\s*(?:…+|\.{3,}|[、，,：:]?\s*第?\s*\d+(?:\.\d+)?\s*条)", early) and heading_count >= 2:
        return True
    if re.search(r"保险责任.{0,120}(?:责任免除|不保什么|保险金申请|如何申请|受益人|释义).{0,180}(?:责任免除|不保什么|保险金申请|如何申请|受益人|释义)", early) and not has_positive:
        return True
    return False


def has_actual_responsibility_text(candidate: str) -> bool:
    text = clean_text(candidate)
    if not text or not RESPONSIBILITY_POSITIVE_RE.search(text):
        return False
    if RESPONSIBILITY_TOC_MARKER_RE.search(text[:500]) and responsibility_heading_count(text[:700]) >= 3:
        return False
    positive_count = len(RESPONSIBILITY_POSITIVE_RE.findall(text))
    negative_count = len(RESPONSIBILITY_NEGATIVE_RE.findall(text))
    return positive_count > 0 and positive_count >= negative_count


def responsibility_match_score(normalized: str, start: int) -> int:
    before = normalized[max(0, start - 220) : start]
    near = normalized[start : start + 900]
    early = near[:300]
    prefix = normalized[max(0, start - 24) : start]
    score = 0
    if is_responsibility_toc_context(normalized, start):
        score -= 14
    if re.search(r"在本(?:主险|附加险|主|附加)?合同(?:的)?(?:保险期间内|有效期内)", near):
        score += 4
    if re.search(r"(?:我们|本公司).{0,60}(?:承担|给付|赔付|赔偿|报销)", near):
        score += 4
    if re.search(r"(?:按|给付|赔付|赔偿|报销).{0,80}(?:保险金|医疗费用|津贴|基本保险金额|有效保险金额)", near):
        score += 3
    if re.search(r"被保险人.{0,120}(?:身故|全残|伤残|残疾|疾病|医疗|住院|意外伤害|烧伤)", near):
        score += 2
    if re.search(r"(?:意外|身故|全残|伤残|残疾|疾病|医疗|住院|津贴|豁免|满期|生存|年金|护理).{0,20}保险金", near):
        score += 2
    if re.search(r"(?:第[一二三四五六七八九十百]+条|[0-9]+(?:\.[0-9]+)+)\s*保险责任", normalized[max(0, start - 80) : start + 20]):
        score += 1
    if RESPONSIBILITY_TOC_RE.search(early):
        score -= 8
    if re.search(
        r"保险责任.{0,160}(?:保险期间(?:与\s*续保)?|我们不保什么|责任免除|其他免责条款).{0,180}(?:如何支付保险费|如何领取保险金|如何申请领取保险金|受益人|保险事故通知|宽限期|效力中止)",
        early,
    ):
        score -= 8
    if re.search(r"责任免除.{0,30}(?:受益人|基本保险金额|如何申请|保险事故通知)", early):
        score -= 5
    if re.search(r"(?:开始承担|履行完毕|已经履行|不承担|承担下列)\s*$", prefix):
        score -= 8
    if re.search(r"^保险责任[”\"'’]\s*[、,，]", near):
        score -= 10
    if re.search(r"详见.{0,100}[“\"'](?:第?\s*\d+(?:\.\d+)*)?\s*保险责任[”\"'’]", normalized[max(0, start - 140) : start + 80]):
        score -= 8
    if re.search(r"^保险责任\s*[，,、]?\s*(?:合同生效|合同效力|的|及|后|时)", near):
        score -= 8
    if re.search(r"目\s*录|条款目录", before[-120:] + early[:120]):
        score -= 4
    if RESPONSIBILITY_NEGATIVE_RE.search(early) and not RESPONSIBILITY_POSITIVE_RE.search(near):
        score -= 5
    if not re.search(r"给付|赔付|赔偿|报销|承担|保险金|医疗费用|身故|全残|伤残|残疾|疾病|住院|津贴|豁免", near[:500]):
        score -= 3
    return score


def select_responsibility_start(normalized: str) -> int:
    candidates = []
    for match in re.finditer(r"保险责任", normalized):
        start = match.start()
        candidates.append((responsibility_match_score(normalized, start), start))
    if not candidates:
        return -1
    score, start = max(candidates, key=lambda item: (item[0], -item[1]))
    return start if score > 0 else -1


def is_responsibility_section_candidate(normalized: str, start: int) -> bool:
    before = normalized[max(0, start - 80) : start]
    near = normalized[start : start + 120]
    if re.search(r"(?:第[一二三四五六七八九十百]+条|[0-9]+(?:[．.]\d+)+)\s*$", before):
        return True
    return bool(
        re.match(
            r"保险责任\s*(?:[：:]|在本(?:主|附加)?合同|在保险期间|本公司(?:依|按|承担)|我们(?:依|按|承担)|一[、.]|1[、.])",
            near,
        )
    )


def focused_responsibility_excerpt(text: str) -> str:
    normalized = normalize_responsibility_source_text(text)
    if not normalized:
        return ""

    def build_candidate(start: int, *, keep_all: bool = False, end_re: re.Pattern[str] = RESPONSIBILITY_END_RE) -> str:
        if start < 0:
            return ""
        tail = normalized[start:]
        end_match = end_re.search(tail[40:])
        excerpt = tail[: 40 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
        if keep_all:
            candidate = excerpt[:MAX_EXCERPT_CHARS].strip()
            return candidate if has_actual_responsibility_text(candidate) else ""
        sentences = re.split(r"(?<=[。；;])", excerpt)
        kept = []
        for sentence in sentences:
            item = sentence.strip()
            if not item:
                continue
            if any(keyword in item for keyword in RESPONSIBILITY_KEYWORDS):
                kept.append(item)
        output = "\n".join(kept).strip()
        candidate = output[:MAX_EXCERPT_CHARS] if output else excerpt[:MAX_EXCERPT_CHARS]
        return candidate if has_actual_responsibility_text(candidate) else ""

    benefit_section = re.search(r"(?:本保险提供的利益保障|主要保单利益|保险利益保障|利益保障)\s*(?=(?:\d+[.、]|[一二三四五六七八九十]+[、.]))", normalized)
    if benefit_section:
        candidate = build_candidate(benefit_section.start(), keep_all=True, end_re=BENEFIT_SECTION_END_RE)
        if candidate:
            return candidate

    preferred = re.search(
        r"附件\s*\d+\s*[：:]\s*本(?:主险|附加险|合同).{0,140}提供.{0,80}保险责任",
        normalized,
    )
    if not preferred:
        preferred = re.search(r"主要保单利益\s*(?:[•·]\s*)?保险责任", normalized)
    if not preferred:
        preferred = re.search(
        r"(?:第[一二三四五六七八九十百]+条|[0-9]+(?:\.[0-9]+)+)\s*保险责任\s*在本(?:主|附加)?合同(?:的)?(?:保险期间内|有效期内)",
        normalized,
        )
    if not preferred:
        preferred = re.search(r"保险责任\s*在本(?:主|附加)?合同(?:的)?(?:保险期间内|有效期内)", normalized)
    if not preferred:
        preferred = re.search(r"第[一二三四五六七八九十百]+条\s*保险责任\s*在本合同保险期间内", normalized)
    if not preferred:
        preferred = re.search(r"保险责任\s*在本合同保险期间内", normalized)
    if not preferred:
        article_matches = list(re.finditer(r"第[一二三四五六七八九十百]+条\s*保险责任", normalized))
        scored_article_matches = [
            (responsibility_match_score(normalized, match.start()), match)
            for match in article_matches
        ]
        scored_article_matches = [item for item in scored_article_matches if item[0] > 0]
        preferred = max(scored_article_matches, key=lambda item: (item[0], -item[1].start()))[1] if scored_article_matches else None
    start = preferred.start() if preferred and responsibility_match_score(normalized, preferred.start()) > 0 else select_responsibility_start(normalized)
    candidate = build_candidate(start)
    if candidate:
        return candidate
    fallback_candidates = []
    for match in re.finditer(r"保险责任", normalized):
        match_start = match.start()
        if match_start == start:
            continue
        if not is_responsibility_section_candidate(normalized, match_start):
            continue
        score = responsibility_match_score(normalized, match_start)
        if score > 0:
            fallback_candidates.append((score, match_start))
    for _, fallback_start in sorted(fallback_candidates, key=lambda item: (item[0], item[1]), reverse=True):
        candidate = build_candidate(fallback_start)
        if candidate:
            return candidate
    return ""


def material_type(label: str, url: str) -> str:
    text = f"{label} {url}"
    if "产品说明书" in text or "产品说明" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return "pdf" if ".pdf" in url.lower() else "html"


def normalize_link_title(title: str, product_name: str) -> str:
    value = trim(title)
    if product_matches(product_name, value):
        return value
    return product_name


def crawl_new_china_row(
    *,
    company: str,
    product_name: str,
    product_type: str = "",
    sales_status: str = "",
    row: Any,
    disclosure_url: str,
    seen_urls: set[str] | None = None,
    skip_urls: set[str] | None = None,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen = seen_urls if seen_urls is not None else set()
    skipped = skip_urls if skip_urls is not None else set()
    product_title = product_name
    for cell in row.find_all("td"):
        cell_text = cell.get_text(" ", strip=True)
        if product_matches(product_name, cell_text):
            product_title = cell_text
            break
    for anchor in row.find_all("a"):
        label = trim(anchor.get_text(" ", strip=True))
        href = trim(anchor.get("href"))
        if label not in RESPONSIBILITY_MATERIAL_LABELS:
            continue
        material_url = urljoin(disclosure_url, href)
        if material_url.lower().endswith(".pdf"):
            pdf_candidates = [{"label": label, "title": product_title, "url": material_url}]
        else:
            material_status, material_html = fetch_html(material_url)
            if material_status < 200 or material_status >= 300:
                continue
            material_soup = BeautifulSoup(material_html, "html.parser")
            pdf_candidates = []
            for pdf_anchor in material_soup.find_all("a"):
                pdf_label = trim(pdf_anchor.get_text(" ", strip=True))
                pdf_href = trim(pdf_anchor.get("href"))
                pdf_url = urljoin(material_url, pdf_href)
                if ".pdf" not in pdf_url.lower():
                    continue
                if EXCLUDED_MATERIAL_RE.search(pdf_label) and not product_matches(product_name, pdf_label):
                    continue
                if not product_matches(product_name, pdf_label):
                    continue
                pdf_candidates.append({"label": label, "title": normalize_link_title(pdf_label, product_name), "url": pdf_url})
        for candidate in pdf_candidates:
            url = candidate["url"]
            if not url or url in seen or url in skipped:
                continue
            seen.add(url)
            pdf_status, data = fetch_bytes(url)
            if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES:
                continue
            extracted = extract_pdf_text_with_system_python(data)
            page_text = focused_responsibility_excerpt(extracted.get("text", ""))
            if not page_text:
                continue
            records.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "title": trim(candidate["title"]) or product_title,
                    "url": url,
                    "snippet": f"新华保险官网{candidate['label']}，已截取保险责任正文段。",
                    "pageText": page_text,
                    "sourceType": "pdf",
                    "materialType": material_type(candidate["label"], url),
                    "official": True,
                    "officialDomain": "static-cdn.newchinalife.com",
                    "parser": "scrapling_new_china_disclosure",
                    "pages": extracted.get("pages", 0),
                    "bytes": len(data),
                }
            )
    return records


def crawl_new_china(company: str, product_name: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for disclosure_base in NEW_CHINA_PRODUCT_DISCLOSURE_URLS:
        disclosure_url = f"{disclosure_base}?{urlencode({'productName': product_name})}"
        status, html = fetch_html(disclosure_url)
        if status < 200 or status >= 300:
            continue
        soup = BeautifulSoup(html, "html.parser")
        for row in soup.find_all("tr"):
            row_text = row.get_text(" ", strip=True)
            if not product_matches(product_name, row_text):
                continue
            records.extend(
                crawl_new_china_row(
                    company=company,
                    product_name=product_name,
                    row=row,
                    disclosure_url=disclosure_url,
                    seen_urls=seen_urls,
                )
            )
    return records


def new_china_page_url(page_base: str, page_number: int) -> str:
    suffix = "" if page_number <= 1 else f"_{page_number}"
    return f"https://www.newchinalife.com/info/{page_base}{suffix}"


def extract_products_from_new_china_page(
    company: str,
    page_url: str,
    max_products: int = 0,
    skip_urls: set[str] | None = None,
    skip_product_names: set[str] | None = None,
) -> dict[str, Any]:
    status, html = fetch_html(page_url)
    if status < 200 or status >= 300:
        return {"url": page_url, "status": status, "products": [], "records": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all("td")]
        if len(cells) < 4:
            continue
        product_name = trim(cells[1])
        labels = {trim(anchor.get_text(" ", strip=True)) for anchor in row.find_all("a")}
        if not product_name or not labels.intersection(RESPONSIBILITY_MATERIAL_LABELS):
            continue
        if skip_product_names and product_name in skip_product_names:
            continue
        product_type = trim(cells[2])
        sales_status = trim(cells[3])
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "sourcePage": page_url,
            }
        )
        records.extend(
            crawl_new_china_row(
                company=company,
                product_name=product_name,
                product_type=product_type,
                sales_status=sales_status,
                row=row,
                disclosure_url=page_url,
                seen_urls=seen_urls,
                skip_urls=skip_urls,
            )
        )
        if max_products and len(products) >= max_products:
            break
    return {"url": page_url, "status": status, "products": products, "records": records}


def crawl_new_china_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "新华保险"
    page_base = trim(payload.get("pageBase")) or "4596"
    start_page = max(1, int(payload.get("startPage") or 1))
    max_pages = max(1, int(payload.get("maxPages") or 1))
    max_products_per_page = max(0, int(payload.get("maxProductsPerPage") or 0))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    skip_product_names = {trim(item) for item in (payload.get("skipProductNames") or []) if trim(item)}
    pages = []
    products = []
    records = []
    for page_number in range(start_page, start_page + max_pages):
        page_url = new_china_page_url(page_base, page_number)
        page_result = extract_products_from_new_china_page(
            company,
            page_url,
            max_products=max_products_per_page,
            skip_urls=skip_urls,
            skip_product_names=skip_product_names,
        )
        pages.append({"url": page_url, "status": page_result["status"], "productCount": len(page_result["products"]), "recordCount": len(page_result["records"])})
        products.extend(page_result["products"])
        records.extend(page_result["records"])
    return {"ok": True, "company": company, "pageBase": page_base, "startPage": start_page, "maxPages": max_pages, "pages": pages, "products": products, "records": records}


def china_life_materials(item: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"key": "clause", "label": "条款", "type": "terms"},
        {"key": "productdescription", "label": "产品说明书", "type": "product_manual"},
    ]


def crawl_china_life_product_records(company: str, item: dict[str, Any], sale_type: str, skip_urls: set[str] | None = None) -> list[dict[str, Any]]:
    product_name = trim(item.get("productname"))
    if not product_name:
        return []
    product_type = trim(item.get("category"))
    sales_status = "在售" if str(sale_type) == "1" else "停售"
    stop_sell_time = trim(item.get("stop_sell_time"))
    if stop_sell_time:
        sales_status = f"{sales_status}（{stop_sell_time}）"
    records: list[dict[str, Any]] = []
    for material in china_life_materials(item):
        href = trim(item.get(material["key"]))
        if not href or href == "/":
            continue
        material_url = urljoin(CHINA_LIFE_OFFICIAL_BASE_URL, href)
        if skip_urls and material_url in skip_urls:
            continue
        pdf_status, data = fetch_bytes(material_url)
        if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES:
            continue
        extracted = extract_pdf_text_with_system_python(data)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        if not page_text:
            continue
        records.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "title": f"{product_name}{material['label']}",
                "url": material_url,
                "snippet": f"中国人寿官网{material['label']}，已截取保险责任正文段。",
                "pageText": page_text,
                "sourceType": "pdf",
                "materialType": material["type"],
                "official": True,
                "officialDomain": "www.e-chinalife.com",
                "parser": "scrapling_china_life_product_info",
                "pages": extracted.get("pages", 0),
                "bytes": len(data),
            }
        )
    return records


def crawl_china_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中国人寿"
    sale_type = str(trim(payload.get("saleType") or payload.get("type")) or "1")
    start_page = max(1, int(payload.get("startPage") or 1))
    max_pages = max(1, int(payload.get("maxPages") or 1))
    page_size = max(1, int(payload.get("pageSize") or 15))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    pages = []
    products = []
    records = []
    for page_number in range(start_page, start_page + max_pages):
        query = urlencode({"pageSize": page_size, "page": page_number, "type": sale_type})
        page_url = f"{CHINA_LIFE_PRODUCT_INFO_ENDPOINT}?{query}"
        status, data = fetch_json(page_url)
        items = data.get("list") if isinstance(data.get("list"), list) else []
        page_records = []
        for item in items:
            product_name = trim(item.get("productname"))
            if not product_name:
                continue
            sales_status = "在售" if sale_type == "1" else "停售"
            stop_sell_time = trim(item.get("stop_sell_time"))
            if stop_sell_time:
                sales_status = f"{sales_status}（{stop_sell_time}）"
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": trim(item.get("category")),
                    "salesStatus": sales_status,
                    "sourcePage": page_url,
                }
            )
            page_records.extend(crawl_china_life_product_records(company, item, sale_type, skip_urls=skip_urls))
        pages.append(
            {
                "url": page_url,
                "status": status,
                "saleType": sale_type,
                "totalCount": int(data.get("count") or 0) if isinstance(data, dict) else 0,
                "productCount": len(items),
                "recordCount": len(page_records),
            }
        )
        records.extend(page_records)
    return {"ok": True, "company": company, "saleType": sale_type, "startPage": start_page, "maxPages": max_pages, "pageSize": page_size, "pages": pages, "products": products, "records": records}


def picc_life_page_url(sale_status: str, page_number: int) -> str:
    profile = PICC_LIFE_PRODUCT_PAGE_BASES.get(sale_status) or PICC_LIFE_PRODUCT_PAGE_BASES["in_sale"]
    path = profile["path"]
    if page_number <= 1:
        return urljoin(PICC_LIFE_OFFICIAL_BASE_URL, path)
    return urljoin(PICC_LIFE_OFFICIAL_BASE_URL, path.replace("index.html", f"index_{page_number}.html"))


def picc_life_material_type(label: str) -> str:
    return "terms" if "条款" in label else "product_manual"


def extract_picc_life_material_url(anchor: Any, page_url: str) -> str:
    href = trim(anchor.get("href"))
    if href and href != "javascript:;":
        return urljoin(page_url, href)
    onclick = trim(anchor.get("onclick"))
    match = re.search(r"product\(\s*['\"]\d+['\"]\s*,\s*['\"]([^'\"]+)['\"]", onclick)
    return urljoin(page_url, match.group(1)) if match else ""


def extract_picc_life_total_pages(soup: BeautifulSoup, sale_status: str) -> int:
    max_page = 1
    profile = PICC_LIFE_PRODUCT_PAGE_BASES.get(sale_status) or PICC_LIFE_PRODUCT_PAGE_BASES["in_sale"]
    folder = profile["path"].rsplit("/", 1)[0]
    for anchor in soup.find_all("a"):
        href = trim(anchor.get("href"))
        if folder not in href:
            continue
        match = re.search(r"index_(\d+)\.html", href)
        if match:
            max_page = max(max_page, int(match.group(1)))
    return max_page


def crawl_picc_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = task["url"]
    pdf_status, data = fetch_bytes_direct(material_url, referer=task["pageUrl"])
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = task["productName"]
    label = task["label"]
    return {
        "company": task["company"],
        "productName": product_name,
        "productType": "",
        "salesStatus": task["salesStatus"],
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"人保寿险官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": picc_life_material_type(label),
        "official": True,
        "officialDomain": "www.picclife.com",
        "parser": "scrapling_picc_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_picc_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_picc_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_picc_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def extract_picc_life_page(company: str, sale_status: str, page_number: int, max_products: int = 0, max_workers: int = 6, skip_urls: set[str] | None = None) -> dict[str, Any]:
    page_url = picc_life_page_url(sale_status, page_number)
    status, html = fetch_picc_life_html(page_url)
    if status < 200 or status >= 300:
        return {"url": page_url, "status": status, "totalPages": 1, "products": [], "records": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    material_tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        first_cell = trim(cells[0].get_text(" ", strip=True))
        product_name_index = 1 if re.fullmatch(r"\d+", first_cell) and len(cells) > 1 else 0
        product_name = trim(cells[product_name_index].get_text(" ", strip=True))
        anchors = [anchor for anchor in row.find_all("a") if trim(anchor.get_text(" ", strip=True)) in {"产品条款", "产品说明书", "产品说明"}]
        if not product_name or not anchors:
            continue
        row_sales_status = PICC_LIFE_PRODUCT_PAGE_BASES.get(sale_status, {}).get("label", "在售")
        stop_date_index = product_name_index + 2
        if sale_status == "stopped" and len(cells) > stop_date_index:
            stop_date = trim(cells[stop_date_index].get_text(" ", strip=True))
            if stop_date:
                row_sales_status = f"{row_sales_status}（{stop_date}）"
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": "",
                "salesStatus": row_sales_status,
                "sourcePage": page_url,
            }
        )
        for anchor in anchors:
            label = trim(anchor.get_text(" ", strip=True))
            material_url = extract_picc_life_material_url(anchor, page_url)
            if not material_url or material_url in seen_urls or (skip_urls and material_url in skip_urls):
                continue
            seen_urls.add(material_url)
            material_tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "salesStatus": row_sales_status,
                    "label": label,
                    "url": material_url,
                    "pageUrl": page_url,
                }
            )
        if max_products and len(products) >= max_products:
            break
    records = crawl_picc_life_material_records(material_tasks, max_workers=max_workers)
    return {
        "url": page_url,
        "status": status,
        "totalPages": extract_picc_life_total_pages(soup, sale_status),
        "products": products,
        "records": records,
    }


def extract_picc_life_pages_concurrently(
    *,
    company: str,
    sale_status: str,
    page_numbers: list[int],
    max_products_per_page: int,
    max_workers: int,
    max_page_workers: int,
    skip_urls: set[str] | None,
) -> dict[int, dict[str, Any]]:
    if not page_numbers:
        return {}
    if max_page_workers <= 1:
        return {
            page_number: extract_picc_life_page(
                company,
                sale_status,
                page_number,
                max_products=max_products_per_page,
                max_workers=max_workers,
                skip_urls=skip_urls,
            )
            for page_number in page_numbers
        }
    results: dict[int, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max_page_workers) as executor:
        futures = {
            executor.submit(
                extract_picc_life_page,
                company,
                sale_status,
                page_number,
                max_products_per_page,
                max_workers,
                skip_urls,
            ): page_number
            for page_number in page_numbers
        }
        for future in as_completed(futures):
            page_number = futures[future]
            try:
                results[page_number] = future.result()
            except Exception as error:
                results[page_number] = {
                    "url": picc_life_page_url(sale_status, page_number),
                    "status": 0,
                    "error": str(error),
                    "totalPages": 1,
                    "products": [],
                    "records": [],
                }
    return results


def crawl_picc_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "人保寿险"
    sale_status = trim(payload.get("saleStatus") or payload.get("status")) or "in_sale"
    if sale_status not in PICC_LIFE_PRODUCT_PAGE_BASES:
        sale_status = "in_sale"
    start_page = max(1, int(payload.get("startPage") or 1))
    max_products_per_page = max(0, int(payload.get("maxProductsPerPage") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or 6))
    max_page_workers = max(1, int(payload.get("maxPageWorkers") or 1))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    first_page_result = extract_picc_life_page(company, sale_status, start_page, max_products=max_products_per_page, max_workers=max_workers, skip_urls=skip_urls)
    detected_total_pages = max(1, int(first_page_result.get("totalPages") or 1))
    requested_max_pages = max(0, int(payload.get("maxPages") or 0))
    if requested_max_pages:
        end_page = min(detected_total_pages, start_page + requested_max_pages - 1)
    else:
        end_page = detected_total_pages
    pages = []
    products = []
    records = []
    remaining_page_numbers = [page_number for page_number in range(start_page, end_page + 1) if page_number != start_page]
    page_results = extract_picc_life_pages_concurrently(
        company=company,
        sale_status=sale_status,
        page_numbers=remaining_page_numbers,
        max_products_per_page=max_products_per_page,
        max_workers=max_workers,
        max_page_workers=max_page_workers,
        skip_urls=skip_urls,
    )
    for page_number in range(start_page, end_page + 1):
        if page_number == start_page:
            page_result = first_page_result
        else:
            page_result = page_results[page_number]
        pages.append(
            {
                "url": page_result["url"],
                "status": page_result["status"],
                "saleStatus": sale_status,
                "pageNumber": page_number,
                "totalPages": detected_total_pages,
                "productCount": len(page_result["products"]),
                "recordCount": len(page_result["records"]),
            }
        )
        products.extend(page_result["products"])
        records.extend(page_result["records"])
    failed_pages = [page for page in pages if int(page.get("status") or 0) < 200 or int(page.get("status") or 0) >= 300]
    return {
        "ok": not failed_pages,
        "code": "" if not failed_pages else "PICC_LIFE_PAGE_FETCH_FAILED",
        "message": "" if not failed_pages else "人保寿险官网产品分页有页面抓取失败，未完成全量爬取。",
        "company": company,
        "saleStatus": sale_status,
        "startPage": start_page,
        "maxPages": requested_max_pages,
        "maxWorkers": max_workers,
        "maxPageWorkers": max_page_workers,
        "detectedTotalPages": detected_total_pages,
        "pages": pages,
        "failedPages": failed_pages,
        "products": products,
        "records": records,
    }


def ping_an_materials(item: dict[str, Any]) -> list[dict[str, str]]:
    materials = []
    if str(item.get("clauseContent")) == "1":
        materials.append({"attachmentType": "1", "label": "产品条款", "type": "terms"})
    if str(item.get("productInstruction")) == "1":
        materials.append({"attachmentType": "7", "label": "产品说明书", "type": "product_manual"})
    return materials


def ping_an_material_url(plan_code: str, version_no: str, attachment_type: str) -> str:
    return f"{PING_AN_PLAN_PDF_ENDPOINT}?{urlencode({'planCode': plan_code, 'versionNo': version_no, 'attachmentType': attachment_type})}"


def ping_an_product_catalog_item(company: str, item: dict[str, Any], sale_type: str) -> dict[str, Any] | None:
    product_name = trim(item.get("clauseName") or item.get("planDesc"))
    if not product_name:
        return None
    plan_code = trim(item.get("actualPlanCode") or item.get("planCode"))
    version_no = trim(item.get("versionNo"))
    product_type = trim(item.get("productLevel") or item.get("productType"))
    end_date = trim(item.get("endDate"))
    sales_status = "在售" if sale_type == "Y" else "停售"
    if end_date and sale_type != "Y":
        sales_status = f"{sales_status}（{end_date}）"
    has_terms = str(item.get("clauseContent")) == "1"
    has_product_manual = str(item.get("productInstruction")) == "1"
    terms_url = ping_an_material_url(plan_code, version_no, "1") if plan_code and version_no and has_terms else ""
    product_manual_url = ping_an_material_url(plan_code, version_no, "7") if plan_code and version_no and has_product_manual else ""
    safe_key = comparable(f"{product_name}{product_type}")[:80] or "unknown"
    catalog_key = f"ping_an_{sale_type}_{plan_code or safe_key}_{version_no or 'no_version'}"
    return {
        "catalogId": catalog_key,
        "company": company,
        "productName": product_name,
        "productType": product_type,
        "salesStatus": sales_status,
        "saleType": sale_type,
        "stopSellDate": end_date,
        "planCode": plan_code,
        "actualPlanCode": trim(item.get("actualPlanCode")),
        "versionNo": version_no,
        "hasTerms": has_terms,
        "hasProductManual": has_product_manual,
        "termsUrl": terms_url,
        "productManualUrl": product_manual_url,
        "officialDomain": "life.pingan.com",
        "sourcePage": PING_AN_PRODUCT_LIST_ENDPOINT,
    }


def crawl_ping_an_product_records(company: str, item: dict[str, Any], sale_type: str) -> list[dict[str, Any]]:
    product_name = trim(item.get("clauseName") or item.get("planDesc"))
    if not product_name:
        return []
    plan_code = trim(item.get("actualPlanCode") or item.get("planCode"))
    version_no = trim(item.get("versionNo"))
    if not plan_code or not version_no:
        return []
    product_type = trim(item.get("productLevel") or item.get("productType"))
    sales_status = "在售" if sale_type == "Y" else "停售"
    end_date = trim(item.get("endDate"))
    if end_date and sale_type != "Y":
        sales_status = f"{sales_status}（{end_date}）"
    records: list[dict[str, Any]] = []
    for material in ping_an_materials(item):
        material_url = ping_an_material_url(plan_code, version_no, material["attachmentType"])
        pdf_status, data = fetch_bytes(material_url)
        if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
            continue
        extracted = extract_pdf_text_with_system_python(data)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        if not page_text:
            continue
        records.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "title": f"{product_name}{material['label']}",
                "url": material_url,
                "snippet": f"中国平安官网{material['label']}，已截取保险责任正文段。",
                "pageText": page_text,
                "sourceType": "pdf",
                "materialType": material["type"],
                "official": True,
                "officialDomain": "life.pingan.com",
                "parser": "scrapling_ping_an_product_info",
                "pages": extracted.get("pages", 0),
                "bytes": len(data),
            }
        )
    return records


def crawl_ping_an_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中国平安"
    sale_type = trim(payload.get("saleType") or payload.get("type")) or "Y"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    request_payload = {
        "isOrNotSale": sale_type,
        "planSalesStatus": sale_type,
        "sourceCode": "ilife-core",
        "planCode": "",
        "planDesc": "",
        "isOnlyNew": "Y",
    }
    status, data = post_json(PING_AN_PRODUCT_LIST_ENDPOINT, request_payload)
    page = {
        "url": PING_AN_PRODUCT_LIST_ENDPOINT,
        "status": status,
        "saleType": sale_type,
        "code": trim(data.get("CODE")) if isinstance(data, dict) else "",
        "message": trim(data.get("MSG")) if isinstance(data, dict) else "",
        "productCount": 0,
        "recordCount": 0,
    }
    if page["code"] == "31019888":
        return {
            "ok": False,
            "code": "PING_AN_HUMAN_VERIFICATION_REQUIRED",
            "message": "平安官网产品接口返回人机检测，需要人工完成官网验证码后再爬取。",
            "company": company,
            "saleType": sale_type,
            "pages": [page],
            "products": [],
            "records": [],
        }
    if page["code"] and page["code"] != "00":
        return {
            "ok": False,
            "code": "PING_AN_PRODUCT_LIST_FAILED",
            "message": page["message"] or "平安官网产品列表接口返回失败。",
            "company": company,
            "saleType": sale_type,
            "pages": [page],
            "products": [],
            "records": [],
        }
    items = data.get("DATA") if isinstance(data.get("DATA"), list) else []
    if max_products:
        items = items[:max_products]
    products = []
    records = []
    for item in items:
        product_name = trim(item.get("clauseName") or item.get("planDesc"))
        if not product_name:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": trim(item.get("productLevel") or item.get("productType")),
                "salesStatus": "在售" if sale_type == "Y" else "停售",
                "sourcePage": PING_AN_PRODUCT_LIST_ENDPOINT,
            }
        )
        records.extend(crawl_ping_an_product_records(company, item, sale_type))
    page["productCount"] = len(products)
    page["recordCount"] = len(records)
    return {"ok": True, "company": company, "saleType": sale_type, "pages": [page], "products": products, "records": records}


async def browser_fetch_json(page: Any, url: str, payload: dict[str, Any]) -> dict[str, Any]:
    return await page.evaluate(
        """async ({url, payload}) => {
            const response = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            const text = await response.text();
            let data = null;
            try { data = JSON.parse(text); } catch { data = {raw: text.slice(0, 1000)}; }
            return {status: response.status, data};
        }""",
        {"url": url, "payload": payload},
    )


async def browser_fetch_bytes(page: Any, url: str) -> tuple[int, str, bytes]:
    result = await page.evaluate(
        """async (url) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60000);
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    signal: controller.signal,
                    headers: {Accept: 'application/zip,application/pdf,*/*'}
                });
                const contentType = response.headers.get('content-type') || '';
                const blob = await response.blob();
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(String(reader.result || '').split(',')[1] || '');
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                return {status: response.status, contentType, base64};
            } catch (error) {
                return {status: 0, contentType: '', base64: ''};
            } finally {
                clearTimeout(timer);
            }
        }""",
        url,
    )
    return int(result.get("status") or 0), trim(result.get("contentType")), base64.b64decode(result.get("base64") or "")


async def ensure_ping_an_product_page(browser: Any) -> Any:
    for context in browser.contexts:
        for page in context.pages:
            if "life.pingan.com" in page.url and "baoxianchanpinmulujitiaokuan" in page.url:
                return page
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    page = await context.new_page()
    await page.goto("https://life.pingan.com/gongkaixinxipilu/baoxianchanpinmulujitiaokuan.jsp", wait_until="domcontentloaded", timeout=60000)
    return page


async def crawl_ping_an_browser_pages_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": []}
    company = trim(payload.get("company")) or "中国平安"
    sale_type = trim(payload.get("saleType") or payload.get("type")) or "Y"
    offset = max(0, int(payload.get("offset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    cdp_url = trim(payload.get("cdpUrl")) or "http://127.0.0.1:9223"
    request_payload = {
        "isOrNotSale": sale_type,
        "planSalesStatus": sale_type,
        "sourceCode": "ilife-core",
        "planCode": "",
        "planDesc": "",
        "isOnlyNew": "Y",
    }
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        page = await ensure_ping_an_product_page(browser)
        response = await browser_fetch_json(page, "/ilife-home/product/getProductList", request_payload)
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        page_meta = {
            "url": PING_AN_PRODUCT_LIST_ENDPOINT,
            "status": int(response.get("status") or 0),
            "saleType": sale_type,
            "code": trim(data.get("CODE")),
            "message": trim(data.get("MSG")),
            "offset": offset,
            "maxProducts": max_products,
            "totalCount": 0,
            "productCount": 0,
            "recordCount": 0,
        }
        if page_meta["code"] == "31019888":
            await browser.close()
            return {
                "ok": False,
                "code": "PING_AN_HUMAN_VERIFICATION_REQUIRED",
                "message": "平安官网产品接口返回人机检测，需要人工完成官网验证码后再爬取。",
                "company": company,
                "saleType": sale_type,
                "pages": [page_meta],
                "products": [],
                "records": [],
            }
        if page_meta["code"] and page_meta["code"] != "00":
            await browser.close()
            return {
                "ok": False,
                "code": "PING_AN_PRODUCT_LIST_FAILED",
                "message": page_meta["message"] or "平安官网产品列表接口返回失败。",
                "company": company,
                "saleType": sale_type,
                "pages": [page_meta],
                "products": [],
                "records": [],
            }
        items = data.get("DATA") if isinstance(data.get("DATA"), list) else []
        page_meta["totalCount"] = len(items)
        selected_items = items[offset : offset + max_products] if max_products else items[offset:]
        products = []
        records = []
        for item in selected_items:
            product_name = trim(item.get("clauseName") or item.get("planDesc"))
            if not product_name:
                continue
            sales_status = "在售" if sale_type == "Y" else "停售"
            end_date = trim(item.get("endDate"))
            if end_date and sale_type != "Y":
                sales_status = f"{sales_status}（{end_date}）"
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": trim(item.get("productLevel") or item.get("productType")),
                    "salesStatus": sales_status,
                    "sourcePage": PING_AN_PRODUCT_LIST_ENDPOINT,
                }
            )
            plan_code = trim(item.get("actualPlanCode") or item.get("planCode"))
            version_no = trim(item.get("versionNo"))
            if not plan_code or not version_no:
                continue
            for material in ping_an_materials(item):
                material_url = ping_an_material_url(plan_code, version_no, material["attachmentType"])
                pdf_status, content_type, data_bytes = await browser_fetch_bytes(page, material_url)
                if pdf_status < 200 or pdf_status >= 300 or len(data_bytes) > MAX_PDF_BYTES or not data_bytes.startswith(b"%PDF"):
                    continue
                extracted = extract_pdf_text_with_system_python(data_bytes)
                page_text = focused_responsibility_excerpt(extracted.get("text", ""))
                if not page_text:
                    continue
                records.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": trim(item.get("productLevel") or item.get("productType")),
                        "salesStatus": sales_status,
                        "title": f"{product_name}{material['label']}",
                        "url": material_url,
                        "snippet": f"中国平安官网{material['label']}，已截取保险责任正文段。",
                        "pageText": page_text,
                        "sourceType": "pdf",
                        "materialType": material["type"],
                        "official": True,
                        "officialDomain": "life.pingan.com",
                        "parser": "scrapling_ping_an_browser_product_info",
                        "pages": extracted.get("pages", 0),
                        "bytes": len(data_bytes),
                        "contentType": content_type,
                    }
                )
        page_meta["productCount"] = len(products)
        page_meta["recordCount"] = len(records)
        await browser.close()
        return {"ok": True, "company": company, "saleType": sale_type, "offset": offset, "maxProducts": max_products, "pages": [page_meta], "products": products, "records": records}


def crawl_ping_an_browser_pages(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(crawl_ping_an_browser_pages_async(payload))


async def crawl_ping_an_browser_catalog_materials_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": []}
    company = trim(payload.get("company")) or "中国平安"
    tasks = payload.get("tasks") if isinstance(payload.get("tasks"), list) else []
    cdp_url = trim(payload.get("cdpUrl")) or "http://127.0.0.1:9223"
    delay_ms = max(0, int(payload.get("delayMs") or 0))
    pdf_retry_count = max(0, int(payload.get("pdfRetryCount") or 0))
    pdf_retry_delay_ms = max(0, int(payload.get("pdfRetryDelayMs") or 0))
    products = []
    records = []
    skipped = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        page = await ensure_ping_an_product_page(browser)
        for task in tasks:
            product_name = trim(task.get("productName"))
            material_url = trim(task.get("url"))
            label = trim(task.get("label"))
            material_type_value = trim(task.get("materialType")) or ping_an_material_type_from_url(material_url)
            if not product_name or not material_url:
                skipped.append({"productName": product_name, "url": material_url, "reason": "missing_product_or_url"})
                continue
            pdf_status, content_type, data_bytes = 0, "", b""
            for attempt in range(pdf_retry_count + 1):
                pdf_status, content_type, data_bytes = await browser_fetch_bytes(page, material_url)
                if data_bytes.startswith(b"%PDF"):
                    break
                should_retry = (
                    attempt < pdf_retry_count
                    and pdf_status == 200
                    and "json" in content_type.lower()
                    and len(data_bytes) <= 1024
                )
                if not should_retry:
                    break
                await asyncio.sleep((pdf_retry_delay_ms or 3000) / 1000)
            if pdf_status < 200 or pdf_status >= 300 or len(data_bytes) > MAX_PDF_BYTES or not data_bytes.startswith(b"%PDF"):
                skipped.append(
                    {
                        "productName": product_name,
                        "url": material_url,
                        "status": pdf_status,
                        "contentType": content_type,
                        "bytes": len(data_bytes),
                        "reason": "pdf_unavailable",
                    }
                )
                if delay_ms:
                    await asyncio.sleep(delay_ms / 1000)
                continue
            extracted = extract_pdf_text_with_system_python(data_bytes)
            page_text = focused_responsibility_excerpt(extracted.get("text", ""))
            if not page_text:
                skipped.append(
                    {
                        "productName": product_name,
                        "url": material_url,
                        "status": pdf_status,
                        "contentType": content_type,
                        "bytes": len(data_bytes),
                        "reason": "no_responsibility_text",
                    }
                )
                if delay_ms:
                    await asyncio.sleep(delay_ms / 1000)
                continue
            records.append(
                {
                    "id": trim(task.get("id")),
                    "company": company,
                    "productName": product_name,
                    "productType": trim(task.get("productType")),
                    "salesStatus": trim(task.get("salesStatus")),
                    "title": f"{product_name}{label or ('产品说明书' if material_type_value == 'product_manual' else '产品条款')}",
                    "url": material_url,
                    "snippet": f"中国平安官网{label or '产品资料'}，已截取保险责任正文段。",
                    "pageText": page_text,
                    "sourceType": "pdf",
                    "materialType": material_type_value,
                    "official": True,
                    "officialDomain": "life.pingan.com",
                    "parser": "scrapling_ping_an_browser_catalog_materials",
                    "pages": extracted.get("pages", 0),
                    "bytes": len(data_bytes),
                    "contentType": content_type,
                }
            )
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": trim(task.get("productType")),
                    "salesStatus": trim(task.get("salesStatus")),
                    "sourcePage": PING_AN_PRODUCT_LIST_ENDPOINT,
                }
            )
            if delay_ms:
                await asyncio.sleep(delay_ms / 1000)
        await browser.close()
    return {
        "ok": True,
        "company": company,
        "taskCount": len(tasks),
        "skippedCount": len(skipped),
        "skipped": skipped,
        "products": products,
        "records": records,
    }


def ping_an_material_type_from_url(url: str) -> str:
    try:
        attachment_type = parse_qs(urlsplit(url).query).get("attachmentType", [""])[0]
    except Exception:
        attachment_type = ""
    return "product_manual" if str(attachment_type) == "7" else "terms"


def crawl_ping_an_browser_catalog_materials(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(crawl_ping_an_browser_catalog_materials_async(payload))


async def crawl_ping_an_browser_catalog_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "products": []}
    company = trim(payload.get("company")) or "中国平安"
    sale_type = trim(payload.get("saleType") or payload.get("type")) or "Y"
    is_only_new = trim(payload.get("isOnlyNew")) or "Y"
    cdp_url = trim(payload.get("cdpUrl")) or "http://127.0.0.1:9223"
    request_payload = {
        "isOrNotSale": sale_type,
        "planSalesStatus": sale_type,
        "sourceCode": "ilife-core",
        "planCode": "",
        "planDesc": "",
        "isOnlyNew": is_only_new,
    }
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        page = await ensure_ping_an_product_page(browser)
        response = await browser_fetch_json(page, "/ilife-home/product/getProductList", request_payload)
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        page_meta = {
            "url": PING_AN_PRODUCT_LIST_ENDPOINT,
            "status": int(response.get("status") or 0),
            "saleType": sale_type,
            "isOnlyNew": is_only_new,
            "code": trim(data.get("CODE")),
            "message": trim(data.get("MSG")),
            "totalCount": 0,
            "productCount": 0,
            "recordCount": 0,
        }
        if page_meta["code"] == "31019888":
            await browser.close()
            return {
                "ok": False,
                "code": "PING_AN_HUMAN_VERIFICATION_REQUIRED",
                "message": "平安官网产品接口返回人机检测，需要人工完成官网验证码后再爬取。",
                "company": company,
                "saleType": sale_type,
                "isOnlyNew": is_only_new,
                "pages": [page_meta],
                "products": [],
                "records": [],
            }
        if page_meta["code"] and page_meta["code"] != "00":
            await browser.close()
            return {
                "ok": False,
                "code": "PING_AN_PRODUCT_LIST_FAILED",
                "message": page_meta["message"] or "平安官网产品列表接口返回失败。",
                "company": company,
                "saleType": sale_type,
                "isOnlyNew": is_only_new,
                "pages": [page_meta],
                "products": [],
                "records": [],
            }
        items = data.get("DATA") if isinstance(data.get("DATA"), list) else []
        products = []
        for item in items:
            catalog_item = ping_an_product_catalog_item(company, item, sale_type)
            if catalog_item:
                products.append(catalog_item)
        page_meta["totalCount"] = len(items)
        page_meta["productCount"] = len(products)
        await browser.close()
        return {
            "ok": True,
            "company": company,
            "saleType": sale_type,
            "isOnlyNew": is_only_new,
            "pages": [page_meta],
            "products": products,
            "records": [],
        }


def crawl_ping_an_browser_catalog(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(crawl_ping_an_browser_catalog_async(payload))


def taikang_life_sale_status_filter(value: str) -> str:
    normalized = trim(value).lower()
    if normalized in {"y", "in_sale", "sale", "active", "在售"}:
        return "在售"
    if normalized in {"n", "stopped", "stop", "停售"}:
        return "停售"
    return "all"


def taikang_life_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "医疗" in product_name or "护理" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def taikang_life_material_type(label: str) -> str:
    if "说明" in label:
        return "product_manual"
    return "terms"


def taikang_life_product_rows(company: str, html: str, sale_status_filter: str, max_products: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    for table_id, base_status in TAIKANG_LIFE_TABLES.items():
        if sale_status_filter != "all" and sale_status_filter != base_status:
            continue
        table = soup.find("table", id=table_id)
        if not table:
            continue
        for row in table.find_all("tr")[1:]:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            product_name = trim(cells[0].get_text(" ", strip=True))
            if not product_name:
                continue
            status = base_status
            if base_status == "停售" and len(cells) >= 3:
                stop_date = trim(cells[2].get_text(" ", strip=True))
                if re.fullmatch(r"\d{4}年\d{2}月\d{2}日", stop_date):
                    status = f"{base_status}（{stop_date}）"
            materials = []
            seen_urls: set[str] = set()
            for option in row.find_all("option"):
                label = trim(option.get_text(" ", strip=True))
                material_url = trim(option.get("value"))
                if label not in {"产品条款", "产品说明书"}:
                    continue
                if not material_url or material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                materials.append(
                    {
                        "label": label,
                        "type": taikang_life_material_type(label),
                        "url": material_url,
                        "enabled": trim(option.get("enabled") or option.get("enabled".lower())),
                        "fileType": trim(option.get("filetype")),
                    }
                )
            if not materials:
                continue
            product_key = f"{base_status}|{product_name}"
            if product_key in seen_products:
                continue
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": taikang_life_product_type(product_name),
                    "salesStatus": status,
                    "sourcePage": TAIKANG_LIFE_PRODUCT_INFO_URL,
                    "tableId": table_id,
                    "riskClass": trim(cells[2].get_text(" ", strip=True)) if base_status == "在售" and len(cells) >= 3 else "",
                    "materials": materials,
                }
            )
            if max_products and len(products) >= max_products:
                return products
    return products


def crawl_taikang_life_material_record(task: dict[str, Any]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes(material_url)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")),
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"泰康人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or taikang_life_material_type(label),
        "official": True,
        "officialDomain": TAIKANG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_taikang_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_taikang_life_material_records(tasks: list[dict[str, Any]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_taikang_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_taikang_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_taikang_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "泰康人寿"
    sale_status_filter = taikang_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or 6))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    status, html = fetch_html(TAIKANG_LIFE_PRODUCT_INFO_URL)
    page_meta = {
        "url": TAIKANG_LIFE_PRODUCT_INFO_URL,
        "status": status,
        "saleStatus": sale_status_filter,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}
    products = taikang_life_product_rows(company, html, sale_status_filter, max_products)
    tasks: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for product in products:
        for material in product.get("materials", []):
            material_url = trim(material.get("url"))
            if not material_url or material_url in seen_urls or material_url in skip_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": company,
                    "productName": product["productName"],
                    "productType": product["productType"],
                    "salesStatus": product["salesStatus"],
                    "label": material["label"],
                    "materialType": material["type"],
                    "url": material_url,
                }
            )
    records = crawl_taikang_life_material_records(tasks, max_workers=max_workers)
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    page_meta["recordCount"] = len(records)
    serializable_products = [{key: value for key, value in product.items() if key != "materials"} for product in products]
    return {
        "ok": True,
        "company": company,
        "source": TAIKANG_LIFE_PRODUCT_INFO_URL,
        "saleStatus": sale_status_filter,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [page_meta],
        "products": serializable_products,
        "records": records,
    }


def sunshine_life_sale_status_id(value: str) -> int:
    normalized = trim(value).lower()
    if normalized in {"y", "in_sale", "sale", "active", "在售", "1"}:
        return 1
    if normalized in {"n", "stopped", "stop", "停售", "2"}:
        return 2
    return 0


def sunshine_life_sales_status(value: Any) -> str:
    text = trim(value)
    if text == "1":
        return "在售"
    if text == "2":
        return "停售"
    return text or "未知"


def sunshine_life_material_type(label: str) -> str:
    return "product_manual" if "说明" in label else "terms"


def sunshine_life_product_type(product: dict[str, Any]) -> str:
    return trim(product.get("riskName")) or taikang_life_product_type(trim(product.get("productName")))


async def fetch_sunshine_life_products(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "pages": [], "products": []}

    sale_status_id = sunshine_life_sale_status_id(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    page_size = max(10, min(100, int(payload.get("pageSize") or 100)))

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1400, "height": 1000})
        await page.goto(SUNSHINE_LIFE_PRODUCT_INFO_URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_function(
            """() => {
              function find(vm) {
                if (!vm) return null;
                if (vm.$options && vm.$options.name === 'SxProInfo') return vm;
                for (const child of (vm.$children || [])) {
                  const found = find(child);
                  if (found) return found;
                }
                return null;
              }
              const root = document.querySelector('#app') && document.querySelector('#app').__vue__;
              const vm = find(root);
              return Boolean(vm && vm.tableData && Array.isArray(vm.tableData.data) && typeof vm.fetchData === 'function');
            }""",
            timeout=60000,
        )
        result = await page.evaluate(
            """async ({ pageSize, maxProducts, saleStatusId }) => {
              function find(vm) {
                if (!vm) return null;
                if (vm.$options && vm.$options.name === 'SxProInfo') return vm;
                for (const child of (vm.$children || [])) {
                  const found = find(child);
                  if (found) return found;
                }
                return null;
              }
              const root = document.querySelector('#app').__vue__;
              const vm = find(root);
              vm.saleStatus = saleStatusId;
              vm.currentPage = 1;
              vm.pageSize = pageSize;
              await vm.fetchData();
              await vm.$nextTick();
              const total = Number(vm.total || 0);
              const pages = Math.max(1, Math.ceil(total / pageSize));
              const productLimit = maxProducts > 0 ? maxProducts : Number.MAX_SAFE_INTEGER;
              const products = [];
              const pageMeta = [];
              for (let pageNumber = 1; pageNumber <= pages && products.length < productLimit; pageNumber += 1) {
                vm.currentPage = pageNumber;
                vm.pageSize = pageSize;
                await vm.fetchData();
                await vm.$nextTick();
                const rows = JSON.parse(JSON.stringify(vm.tableData.data || []));
                for (const row of rows) {
                  row.sourcePageNumber = pageNumber;
                  products.push(row);
                  if (products.length >= productLimit) break;
                }
                pageMeta.push({
                  url: `${location.href}#page=${pageNumber}`,
                  status: 200,
                  saleStatusId,
                  pageNumber,
                  productCount: rows.length,
                  materialTaskCount: 0,
                  recordCount: 0,
                  totalCount: Number(vm.total || total || 0),
                });
              }
              return { total, pageSize, pageCount: pages, pages: pageMeta, products };
            }""",
            {"pageSize": page_size, "maxProducts": max_products, "saleStatusId": sale_status_id},
        )
        await browser.close()
        return {"ok": True, **result}


def sunshine_life_material_tasks(company: str, products: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    serializable_products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()
    for product in products:
        product_name = trim(product.get("productName"))
        if not product_name:
            continue
        product_type = sunshine_life_product_type(product)
        sales_status = sunshine_life_sales_status(product.get("saleStatus"))
        source_page = f"{SUNSHINE_LIFE_PRODUCT_INFO_URL}#page={trim(product.get('sourcePageNumber')) or '1'}"
        serializable_products.append(
            {
                "company": company,
                "productName": product_name,
                "productCode": trim(product.get("productCode")),
                "productType": product_type,
                "productLevel": trim(product.get("productLvl")),
                "salesStatus": sales_status,
                "releaseTime": trim(product.get("releaseTime")),
                "sourcePage": source_page,
            }
        )
        info_list = product.get("infoList") if isinstance(product.get("infoList"), list) else []
        for info in info_list:
            label = trim(info.get("infoName"))
            if label not in {"条款", "产品说明书"} and "产品说明" not in label:
                continue
            file_list = info.get("fileList") if isinstance(info.get("fileList"), list) else []
            for file_item in file_list:
                material_url = trim(file_item.get("url"))
                title = trim(file_item.get("name")) or f"{product_name}{label}"
                if not material_url or material_url in seen_task_urls:
                    continue
                if ".pdf" not in material_url.lower() or EXCLUDED_MATERIAL_RE.search(title):
                    continue
                seen_task_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": sales_status,
                        "label": label,
                        "materialType": sunshine_life_material_type(label),
                        "title": title,
                        "url": material_url,
                        "sourcePage": source_page,
                    }
                )
    return serializable_products, tasks


def crawl_sunshine_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=SUNSHINE_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "阳光人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": trim(task.get("title")) or f"{product_name}{label}",
        "url": material_url,
        "snippet": f"阳光人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or sunshine_life_material_type(label),
        "official": True,
        "officialDomain": SUNSHINE_LIFE_PDF_DOMAIN,
        "parser": "scrapling_sunshine_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_sunshine_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_sunshine_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_sunshine_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_sunshine_life_browser_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "阳光人寿"
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    browser_result = asyncio.run(fetch_sunshine_life_products(payload))
    if not browser_result.get("ok"):
        return {"ok": False, "company": company, **browser_result, "records": []}

    products, tasks = sunshine_life_material_tasks(company, browser_result.get("products") or [])
    records = crawl_sunshine_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    pages = browser_result.get("pages") if isinstance(browser_result.get("pages"), list) else []
    task_counts_by_page: dict[str, int] = {}
    for task in tasks:
        page_url = trim(task.get("sourcePage"))
        task_counts_by_page[page_url] = task_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page_url = trim(page.get("url"))
        page["materialTaskCount"] = task_counts_by_page.get(page_url, 0)
        page["recordCount"] = record_counts_by_page.get(page_url, 0)

    return {
        "ok": True,
        "company": company,
        "source": SUNSHINE_LIFE_PRODUCT_INFO_URL,
        "officialDomain": SUNSHINE_LIFE_OFFICIAL_DOMAIN,
        "pdfDomain": SUNSHINE_LIFE_PDF_DOMAIN,
        "saleStatus": trim(payload.get("saleStatus") or payload.get("status")) or "all",
        "maxProducts": max(0, int(payload.get("maxProducts") or 0)),
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def guohua_life_sale_status_filter(value: str) -> str:
    normalized = trim(value).lower()
    if normalized in {"y", "in_sale", "sale", "active", "在售"}:
        return "在售"
    if normalized in {"n", "stopped", "stop", "discontinued", "停售"}:
        return "停售"
    return "all"


def guohua_life_product_type(product_name: str) -> str:
    if "医疗" in product_name:
        return "医疗险"
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def guohua_life_material_type(label: str, url: str = "") -> str:
    if "说明" in label or "shuoming" in url.lower():
        return "product_manual"
    return "terms"


def guohua_life_normalize_material_label(label: str, url: str, product_name: str) -> str:
    label = trim(label)
    if "说明" in label or "shuoming" in url.lower():
        return "产品说明书"
    if "条款" in label:
        return label
    if not label or label == "查看" or comparable(label) == comparable(product_name):
        return "产品条款"
    return label


def guohua_life_keep_pdf_material(label: str, url: str) -> bool:
    lower_url = trim(url).lower()
    if ".pdf" not in lower_url:
        return False
    label = trim(label)
    ignored_keywords = [
        "清单",
        "声明",
        "偿付能力",
        "业务规划",
        "精算报告",
        "可行性报告",
        "销售政策",
        "定价",
        "报送材料",
    ]
    if any(keyword in label for keyword in ignored_keywords):
        return False
    return True


def guohua_life_product_rows(company: str, html: str, sale_status_filter: str, max_products: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    article = soup.find(id="article") or soup
    products: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    seen_products: set[str] = set()

    def push_current() -> None:
        nonlocal current
        if not current:
            return
        if not current.get("sourceLinks"):
            current = None
            return
        sales_status = trim(current.get("salesStatus"))
        if sale_status_filter != "all" and sale_status_filter != sales_status:
            current = None
            return
        key = f"{sales_status}|{current.get('productName')}"
        if key not in seen_products:
            seen_products.add(key)
            products.append(current)
        current = None

    for paragraph in article.find_all("p"):
        text = re.sub(r"\s+", " ", paragraph.get_text(" ", strip=True)).strip()
        match = re.match(r"^(\d+)\s+(.+?)\s+(在售|停售)\s*$", text)
        if match:
            push_current()
            product_name = trim(match.group(2))
            current = {
                "company": company,
                "productName": product_name,
                "productType": guohua_life_product_type(product_name),
                "salesStatus": trim(match.group(3)),
                "sourcePage": GUOHUA_LIFE_PRODUCT_INFO_URL,
                "sourceIndex": int(match.group(1)),
                "sourceLinks": [],
            }
            continue
        if not current:
            continue
        for anchor in paragraph.find_all("a"):
            href = trim(anchor.get("href"))
            if not href:
                continue
            current["sourceLinks"].append(
                {
                    "label": html_text(str(anchor)) or "查看",
                    "url": urljoin(GUOHUA_LIFE_PRODUCT_INFO_URL, href),
                }
            )
    push_current()
    if max_products:
        return products[:max_products]
    return products


def guohua_life_detail_materials(detail_url: str, product_name: str) -> list[dict[str, str]]:
    status, html = fetch_html_direct(detail_url, referer=GUOHUA_LIFE_PRODUCT_INFO_URL)
    if status < 200 or status >= 300 or not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    materials: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for anchor in soup.find_all("a"):
        href = trim(anchor.get("href"))
        if not href:
            continue
        material_url = urljoin(detail_url, href)
        raw_label = html_text(str(anchor))
        if not guohua_life_keep_pdf_material(raw_label, material_url):
            continue
        if material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        label = guohua_life_normalize_material_label(raw_label, material_url, product_name)
        materials.append(
            {
                "label": label,
                "type": guohua_life_material_type(label, material_url),
                "url": material_url,
                "sourcePage": detail_url,
            }
        )
    return materials


def guohua_life_material_tasks(products: list[dict[str, Any]], max_workers: int) -> list[dict[str, str]]:
    direct_tasks: list[dict[str, str]] = []
    detail_jobs: list[tuple[dict[str, Any], dict[str, str]]] = []

    def make_task(product: dict[str, Any], material: dict[str, str]) -> dict[str, str]:
        label = guohua_life_normalize_material_label(
            trim(material.get("label")),
            trim(material.get("url")),
            trim(product.get("productName")),
        )
        return {
            "company": trim(product.get("company")),
            "productName": trim(product.get("productName")),
            "productType": trim(product.get("productType")),
            "salesStatus": trim(product.get("salesStatus")),
            "label": label,
            "materialType": trim(material.get("type")) or guohua_life_material_type(label, trim(material.get("url"))),
            "url": trim(material.get("url")),
            "sourcePage": trim(material.get("sourcePage")) or trim(product.get("sourcePage")),
        }

    for product in products:
        for link in product.get("sourceLinks", []):
            link_url = trim(link.get("url"))
            if not link_url:
                continue
            if ".pdf" in link_url.lower():
                label = guohua_life_normalize_material_label(trim(link.get("label")), link_url, trim(product.get("productName")))
                direct_tasks.append(
                    make_task(
                        product,
                        {
                            "label": label,
                            "type": guohua_life_material_type(label, link_url),
                            "url": link_url,
                            "sourcePage": trim(product.get("sourcePage")),
                        },
                    )
                )
            else:
                detail_jobs.append((product, {"label": trim(link.get("label")), "url": link_url}))

    detail_tasks: list[dict[str, str]] = []
    if detail_jobs and max_workers > 1:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(guohua_life_detail_materials, trim(job[1].get("url")), trim(job[0].get("productName"))): job[0]
                for job in detail_jobs
            }
            for future in as_completed(futures):
                product = futures[future]
                for material in future.result():
                    detail_tasks.append(make_task(product, material))
    else:
        for product, link in detail_jobs:
            for material in guohua_life_detail_materials(trim(link.get("url")), trim(product.get("productName"))):
                detail_tasks.append(make_task(product, material))

    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for task in [*direct_tasks, *detail_tasks]:
        material_url = trim(task.get("url"))
        if not material_url or material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        tasks.append(task)
    return tasks


def crawl_guohua_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or GUOHUA_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "国华人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"国华人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or guohua_life_material_type(label, material_url),
        "official": True,
        "officialDomain": GUOHUA_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_guohua_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_guohua_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_guohua_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_guohua_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_guohua_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "国华人寿"
    sale_status_filter = guohua_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, html = fetch_html_direct(GUOHUA_LIFE_PRODUCT_INFO_URL, referer="https://www.95549.cn/")
    page_meta = {
        "url": GUOHUA_LIFE_PRODUCT_INFO_URL,
        "status": status,
        "saleStatus": sale_status_filter,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}

    products = guohua_life_product_rows(company, html, sale_status_filter, max_products)
    tasks = guohua_life_material_tasks(products, max_workers=max_workers)
    records = crawl_guohua_life_material_records(tasks, max_workers=max_workers)
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    page_meta["recordCount"] = len(records)

    return {
        "ok": True,
        "company": company,
        "source": GUOHUA_LIFE_PRODUCT_INFO_URL,
        "officialDomain": GUOHUA_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sale_status_filter,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [page_meta],
        "products": [{key: value for key, value in product.items() if key != "sourceLinks"} for product in products],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def happy_life_sale_status_keys(value: str) -> set[str]:
    normalized = trim(value).lower()
    if normalized in {"y", "in_sale", "sale", "active", "在售"}:
        return {"in_sale"}
    if normalized in {"n", "stopped", "stop", "discontinued", "停售"}:
        return {"stopped"}
    return {"in_sale", "stopped"}


def happy_life_product_type(product_name: str) -> str:
    if "医疗" in product_name:
        return "医疗险"
    if "重大疾病" in product_name or "疾病" in product_name or "特药" in product_name or "护理" in product_name:
        return "健康险"
    if "意外" in product_name or "旅行" in product_name or "驾乘" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def happy_life_material_type(label: str) -> str:
    normalized = trim(label)
    if "说明" in normalized:
        return "product_manual"
    return "terms"


def happy_life_keep_material(label: str, url: str) -> bool:
    if ".pdf" not in trim(url).lower():
        return False
    normalized = trim(label)
    if not normalized:
        return False
    if "条款" in normalized or "产品说明" in normalized:
        return True
    return normalized in {"说明书", "说明"}


def happy_life_normalize_product_name(product_name: str) -> tuple[str, str]:
    product_name = trim(product_name)
    stopped = re.search(r"（自(.+?)起停止使用）", product_name)
    if stopped:
        product_name = product_name[: stopped.start()] + product_name[stopped.end() :]
        return trim(product_name), f"停售（自{stopped.group(1)}起停止使用）"
    return product_name, ""


def happy_life_product_rows(company: str, page_key: str, html: str, page_url: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    base_status = HAPPY_LIFE_PRODUCT_PAGES[page_key]["salesStatus"]
    products: list[dict[str, Any]] = []
    for row in soup.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 3:
            continue
        raw_index = trim(cells[0].get_text(" ", strip=True))
        if not raw_index.isdigit():
            continue
        raw_name = trim(cells[1].get_text(" ", strip=True))
        product_name, stopped_status = happy_life_normalize_product_name(raw_name)
        if not product_name:
            continue
        materials: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        for anchor in cells[2].find_all("a"):
            label = trim(anchor.get_text(" ", strip=True))
            href = trim(anchor.get("href"))
            material_url = urljoin(page_url, href)
            if not happy_life_keep_material(label, material_url):
                continue
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            materials.append(
                {
                    "label": label,
                    "type": happy_life_material_type(label),
                    "url": material_url,
                }
            )
        if not materials:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": happy_life_product_type(product_name),
                "salesStatus": stopped_status or base_status,
                "sourcePage": page_url,
                "sourceStatus": page_key,
                "sourceIndex": int(raw_index),
                "materials": materials,
            }
        )
    return products


def crawl_happy_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or HAPPY_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "幸福人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"幸福人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or happy_life_material_type(label),
        "official": True,
        "officialDomain": HAPPY_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_happy_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_happy_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_happy_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_happy_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_happy_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "幸福人寿"
    status_keys = happy_life_sale_status_keys(trim(payload.get("saleStatus") or payload.get("status")))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    products: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []

    for page_key, page_config in HAPPY_LIFE_PRODUCT_PAGES.items():
        if page_key not in status_keys:
            continue
        page_number = 1
        while True:
            if max_pages and page_number > max_pages:
                break
            page_url = page_config["pattern"].format(page=page_number)
            status, html = fetch_html_direct(page_url, referer=HAPPY_LIFE_OFFICIAL_BASE_URL)
            page_meta = {
                "url": page_url,
                "status": status,
                "sourceStatus": page_key,
                "salesStatus": page_config["salesStatus"],
                "page": page_number,
                "productCount": 0,
                "materialTaskCount": 0,
                "recordCount": 0,
            }
            if status < 200 or status >= 300:
                pages.append(page_meta)
                break
            page_products = happy_life_product_rows(company, page_key, html, page_url)
            if not page_products:
                break
            remaining = max_products - len(products) if max_products else 0
            if max_products and remaining <= 0:
                break
            if max_products and len(page_products) > remaining:
                page_products = page_products[:remaining]
            page_meta["productCount"] = len(page_products)
            page_meta["materialTaskCount"] = sum(len(product.get("materials", [])) for product in page_products)
            pages.append(page_meta)
            products.extend(page_products)
            if max_products and len(products) >= max_products:
                break
            page_number += 1

    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for product in products:
        for material in product.get("materials", []):
            material_url = trim(material.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": trim(product.get("company")),
                    "productName": trim(product.get("productName")),
                    "productType": trim(product.get("productType")),
                    "salesStatus": trim(product.get("salesStatus")),
                    "label": trim(material.get("label")),
                    "materialType": trim(material.get("type")),
                    "url": material_url,
                    "sourcePage": trim(product.get("sourcePage")),
                }
            )

    records = crawl_happy_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page_meta in pages:
        page_meta["recordCount"] = record_counts_by_page.get(page_meta["url"], 0)

    return {
        "ok": True,
        "company": company,
        "source": ", ".join(HAPPY_LIFE_PRODUCT_PAGES[key]["pattern"].format(page=1) for key in HAPPY_LIFE_PRODUCT_PAGES if key in status_keys),
        "officialDomain": HAPPY_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": trim(payload.get("saleStatus") or payload.get("status")) or "all",
        "maxPages": max_pages,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": [{key: value for key, value in product.items() if key != "materials"} for product in products],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def caixin_life_sale_status_keys(value: str) -> set[str]:
    normalized = trim(value).lower()
    if normalized in {"y", "in_sale", "sale", "active", "在售"}:
        return {"in_sale"}
    if normalized in {"n", "stopped", "stop", "discontinued", "停售"}:
        return {"stopped"}
    return {"in_sale", "stopped"}


def caixin_life_product_type(product_name: str) -> str:
    if "医疗" in product_name:
        return "医疗险"
    if "重大疾病" in product_name or "疾病" in product_name or "特药" in product_name or "护理" in product_name:
        return "健康险"
    if "意外" in product_name or "旅行" in product_name or "驾乘" in product_name or "交通工具" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def caixin_life_is_official_url(url: str) -> bool:
    host = urlsplit(trim(url)).hostname or ""
    return host == CAIXIN_LIFE_OFFICIAL_DOMAIN or host.endswith(".hnchasing.com")


def caixin_life_material_from_cell(cell: Any, label: str, material_type: str, page_url: str) -> dict[str, str] | None:
    anchor = cell.find("a", href=True)
    if not anchor:
        return None
    material_url = urljoin(page_url, trim(anchor.get("href")))
    if ".pdf" not in material_url.lower() or not caixin_life_is_official_url(material_url):
        return None
    return {
        "label": label,
        "type": material_type,
        "url": material_url,
    }


def caixin_life_product_rows(
    company: str,
    page_key: str,
    html: str,
    page_url: str,
    start_index: int,
    max_products: int,
) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    sales_status = CAIXIN_LIFE_PRODUCT_PAGES[page_key]["salesStatus"]
    rows = soup.select("tr.productinfo-row")
    products: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        if start_index and index < start_index:
            continue
        cells = row.find_all("td")
        if len(cells) < 6:
            continue
        product_name = trim(cells[0].get_text(" ", strip=True))
        if not product_name:
            continue
        materials: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        for material in (
            caixin_life_material_from_cell(cells[3], "产品条款", "terms", page_url),
            caixin_life_material_from_cell(cells[5], "产品说明书", "product_manual", page_url),
        ):
            if not material:
                continue
            material_url = trim(material.get("url"))
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            materials.append(material)
        if not materials:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": caixin_life_product_type(product_name),
                "salesStatus": sales_status,
                "sourcePage": page_url,
                "sourceStatus": page_key,
                "sourceIndex": index,
                "riskLevel": trim(cells[1].get_text(" ", strip=True)),
                "materials": materials,
            }
        )
        if max_products and len(products) >= max_products:
            break
    return products


def crawl_caixin_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not caixin_life_is_official_url(material_url):
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or CAIXIN_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "财信人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"财信人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": CAIXIN_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_caixin_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_caixin_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_caixin_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_caixin_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_caixin_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "财信人寿"
    status_keys = caixin_life_sale_status_keys(trim(payload.get("saleStatus") or payload.get("status")))
    start_index = max(1, int(payload.get("startIndex") or payload.get("offset") or 1))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    products: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []

    for page_key, page_config in CAIXIN_LIFE_PRODUCT_PAGES.items():
        if page_key not in status_keys:
            continue
        remaining = max_products - len(products) if max_products else 0
        if max_products and remaining <= 0:
            break
        page_url = page_config["url"]
        status, html = fetch_html_direct(page_url, referer=CAIXIN_LIFE_OFFICIAL_BASE_URL)
        page_meta = {
            "url": page_url,
            "status": status,
            "sourceStatus": page_key,
            "salesStatus": page_config["salesStatus"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            continue
        page_products = caixin_life_product_rows(
            company,
            page_key,
            html,
            page_url,
            start_index,
            remaining if max_products else 0,
        )
        page_meta["productCount"] = len(page_products)
        page_meta["materialTaskCount"] = sum(len(product.get("materials", [])) for product in page_products)
        pages.append(page_meta)
        products.extend(page_products)

    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for product in products:
        for material in product.get("materials", []):
            material_url = trim(material.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": trim(product.get("company")),
                    "productName": trim(product.get("productName")),
                    "productType": trim(product.get("productType")),
                    "salesStatus": trim(product.get("salesStatus")),
                    "label": trim(material.get("label")),
                    "materialType": trim(material.get("type")),
                    "url": material_url,
                    "sourcePage": trim(product.get("sourcePage")),
                }
            )

    records = crawl_caixin_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page_meta in pages:
        page_meta["recordCount"] = record_counts_by_page.get(page_meta["url"], 0)

    return {
        "ok": True,
        "company": company,
        "source": ", ".join(CAIXIN_LIFE_PRODUCT_PAGES[key]["url"] for key in CAIXIN_LIFE_PRODUCT_PAGES if key in status_keys),
        "officialDomain": CAIXIN_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": trim(payload.get("saleStatus") or payload.get("status")) or "all",
        "startIndex": start_index,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": [{key: value for key, value in product.items() if key != "materials"} for product in products],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def china_taiping_terms_urls(payload: dict[str, Any]) -> list[str]:
    urls = []
    if payload.get("scanRange", True):
        start_id = max(1, int(payload.get("startId") or 1000))
        end_id = max(start_id, int(payload.get("endId") or 4210))
        patterns = payload.get("patterns")
        if not isinstance(patterns, list) or not patterns:
            patterns = ["cptk_{id}.html", "4_cptk_{id}.html"]
        for product_id in range(start_id, end_id + 1):
            for pattern in patterns:
                path = trim(pattern).format(id=product_id)
                if path:
                    urls.append(urljoin(CHINA_TAIPING_WCP_BASE_URL, path))
        if payload.get("includeCompound", True):
            urls.extend(urljoin(CHINA_TAIPING_WCP_BASE_URL, path) for path in CHINA_TAIPING_COMPOUND_TERMS)
    explicit_urls = payload.get("urls")
    if isinstance(explicit_urls, list):
        urls.extend(trim(url) for url in explicit_urls if trim(url))
    return sorted(dict.fromkeys(urls))


def china_taiping_product_type(title: str) -> str:
    if "重大疾病" in title or "防癌" in title or "特定疾病" in title:
        return "健康险"
    if "医疗" in title or "药品费用" in title or "质子重离子" in title:
        return "医疗险"
    if "意外" in title:
        return "意外险"
    if "年金" in title or "养老" in title:
        return "年金险"
    if "两全" in title:
        return "两全保险"
    if "终身寿险" in title or "定期寿险" in title:
        return "寿险"
    return ""


def china_taiping_product_name(title: str) -> str:
    value = trim(title)
    value = re.sub(r"^\d+", "", value).strip()
    value = re.sub(r"条款$", "", value).strip()
    return value


def fetch_china_taiping_html_urls(urls: list[str], concurrency: int = 24, timeout_seconds: float = 1.5) -> list[tuple[str, int, str]]:
    try:
        import httpx
    except Exception:
        results = []
        for url in urls:
            status, html = fetch_html(url)
            results.append((url, status, html))
        return results

    async def run() -> list[tuple[str, int, str]]:
        semaphore = asyncio.Semaphore(max(1, concurrency))

        async def get(client: Any, url: str) -> tuple[str, int, str]:
            async with semaphore:
                try:
                    response = await client.get(url, timeout=timeout_seconds)
                    return url, int(response.status_code), response.text
                except Exception:
                    return url, 0, ""

        async with httpx.AsyncClient(headers={"User-Agent": "Mozilla/5.0"}, follow_redirects=True, verify=False) as client:
            return await asyncio.gather(*(get(client, url) for url in urls))

    return asyncio.run(run())


def extract_china_taiping_records_from_html(company: str, url: str, html: str) -> list[dict[str, Any]]:
    if "cptk_h1" not in html or "保险责任" not in html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    titles = [clean_text(node.get_text(" ", strip=True)) for node in soup.select(".cptk_h1")]
    titles = [title for title in titles if title]
    if not titles:
        return []
    full_text = html_text(html)
    records = []
    for index, title in enumerate(titles):
        start = full_text.find(title)
        next_start = full_text.find(titles[index + 1], start + len(title)) if index + 1 < len(titles) and start >= 0 else -1
        section_text = full_text[start:next_start] if start >= 0 and next_start > start else full_text[start:] if start >= 0 else full_text
        page_text = focused_responsibility_excerpt(section_text)
        if not page_text:
            continue
        product_name = china_taiping_product_name(title)
        source_url = url if len(titles) == 1 else f"{url}#contract-{index + 1}"
        records.append(
            {
                "company": company,
                "productName": product_name,
                "productType": china_taiping_product_type(title),
                "salesStatus": "官网未披露",
                "title": title,
                "url": source_url,
                "snippet": "太平人寿官网产品条款页面，已截取保险责任正文段。",
                "pageText": page_text,
                "sourceType": "html",
                "materialType": "terms",
                "official": True,
                "officialDomain": "tpwx.life.cntaiping.com",
                "parser": "scrapling_china_taiping_wcp_terms",
            }
        )
    return records


def decode_china_taiping_js_value(value: str) -> str:
    text = html_lib.unescape(value or "")
    return text.replace("\\'", "'").replace('\\"', '"').strip()


def china_taiping_disclosure_material_type(label: str) -> str:
    if "条款" in label:
        return "terms"
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    return ""


def china_taiping_disclosure_sales_status(type_value: str) -> str:
    return "停售" if str(type_value) == "999" else "在售"


def parse_china_taiping_disclosure_entries(html: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    entry_re = re.compile(
        r"\{'contentId':(\d+),'contentName':'((?:\\'|[^'])*)','name':'((?:\\'|[^'])*)',path:'((?:\\'|[^'])*)',date:'((?:\\'|[^'])*)',type:(\d+)\}"
    )
    for match in entry_re.finditer(html or ""):
        label = decode_china_taiping_js_value(match.group(3))
        material = china_taiping_disclosure_material_type(label)
        if not material:
            continue
        path = decode_china_taiping_js_value(match.group(4))
        material_url = urljoin(CHINA_TAIPING_OFFICIAL_BASE_URL, path)
        entries.append(
            {
                "contentId": match.group(1),
                "productName": decode_china_taiping_js_value(match.group(2)),
                "label": label,
                "url": material_url,
                "date": decode_china_taiping_js_value(match.group(5)),
                "type": match.group(6),
                "materialType": material,
                "salesStatus": china_taiping_disclosure_sales_status(match.group(6)),
            }
        )
    return entries


def china_taiping_disclosure_material_filter(value: str) -> set[str]:
    normalized = trim(value).lower()
    if not normalized or normalized == "all":
        return {"terms", "product_manual"}
    if normalized in {"term", "terms"}:
        return {"terms"}
    if normalized in {"manual", "manuals", "product_manual", "product_manuals"}:
        return {"product_manual"}
    return {item.strip() for item in re.split(r"[,，]", normalized) if item.strip()}


def crawl_china_taiping_disclosure_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=CHINA_TAIPING_DISCLOSURE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    sales_status = trim(task.get("salesStatus"))
    return {
        "company": trim(task.get("company")) or "中国太平",
        "productName": product_name,
        "productType": china_taiping_product_type(product_name),
        "salesStatus": sales_status,
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"太平人寿官网{sales_status}产品{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": "life.cntaiping.com",
        "parser": "scrapling_china_taiping_disclosure_pdf",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_china_taiping_disclosure_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_china_taiping_disclosure_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_china_taiping_disclosure_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_china_taiping_disclosure_html(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中国太平"
    html_path = trim(payload.get("htmlPath"))
    if html_path:
        with open(html_path, "r", encoding="utf-8") as handle:
            html = handle.read()
        status = 200
        source = html_path
    else:
        status, html = fetch_html(CHINA_TAIPING_DISCLOSURE_URL)
        source = CHINA_TAIPING_DISCLOSURE_URL
    all_entries = parse_china_taiping_disclosure_entries(html)
    allowed_materials = china_taiping_disclosure_material_filter(trim(payload.get("material") or payload.get("materials")))
    entries = [entry for entry in all_entries if entry["materialType"] in allowed_materials]
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    seen_urls: set[str] = set()
    deduped_entries: list[dict[str, str]] = []
    for entry in entries:
        if entry["url"] in seen_urls or entry["url"] in skip_urls:
            continue
        seen_urls.add(entry["url"])
        deduped_entries.append(entry)
    offset = max(0, int(payload.get("offset") or 0))
    max_records = max(0, int(payload.get("maxRecords") or payload.get("maxProducts") or 0))
    selected_entries = deduped_entries[offset : offset + max_records] if max_records else deduped_entries[offset:]
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    tasks = [{**entry, "company": company} for entry in selected_entries]
    records = crawl_china_taiping_disclosure_material_records(tasks, max_workers=max_workers)
    products = []
    seen_products: set[str] = set()
    for entry in selected_entries:
        key = f"{entry['productName']}|{entry['salesStatus']}"
        if key in seen_products:
            continue
        seen_products.add(key)
        products.append(
            {
                "company": company,
                "productName": entry["productName"],
                "productType": china_taiping_product_type(entry["productName"]),
                "salesStatus": entry["salesStatus"],
                "sourcePage": CHINA_TAIPING_DISCLOSURE_URL,
            }
        )
    return {
        "ok": status >= 200 and status < 300,
        "company": company,
        "source": source,
        "officialSource": CHINA_TAIPING_DISCLOSURE_URL,
        "discoveredMaterialCount": len(all_entries),
        "filteredMaterialCount": len(deduped_entries),
        "selectedMaterialCount": len(selected_entries),
        "offset": offset,
        "maxRecords": max_records,
        "maxWorkers": max_workers,
        "pages": [
            {
                "url": CHINA_TAIPING_DISCLOSURE_URL,
                "status": status,
                "productCount": len(products),
                "materialTaskCount": len(selected_entries),
                "recordCount": len(records),
            }
        ],
        "products": products,
        "records": records,
    }


def crawl_china_taiping_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中国太平"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    urls = china_taiping_terms_urls(payload)
    fetched = fetch_china_taiping_html_urls(
        urls,
        concurrency=max(1, int(payload.get("concurrency") or 24)),
        timeout_seconds=max(0.5, float(payload.get("timeoutSeconds") or 1.5)),
    )
    pages = []
    products = []
    records = []
    for url, status, html in sorted(fetched, key=lambda item: item[0]):
        page_records = extract_china_taiping_records_from_html(company, url, html)
        if not page_records:
            continue
        if max_products and len(products) >= max_products:
            break
        if max_products:
            remaining = max_products - len(products)
            page_records = page_records[:remaining]
        pages.append({"url": url, "status": status, "productCount": len(page_records), "recordCount": len(page_records)})
        for record in page_records:
            products.append(
                {
                    "company": company,
                    "productName": record["productName"],
                    "productType": record["productType"],
                    "salesStatus": record["salesStatus"],
                    "sourcePage": url,
                }
            )
        records.extend(page_records)
    return {
        "ok": True,
        "company": company,
        "source": CHINA_TAIPING_WCP_BASE_URL,
        "scannedUrlCount": len(urls),
        "matchedPageCount": len(pages),
        "pages": pages,
        "products": products,
        "records": records,
    }


def cpic_life_page_url(path: str, page_number: int) -> str:
    url = urljoin(CPIC_LIFE_OFFICIAL_BASE_URL, path)
    if page_number <= 1:
        return url
    return url.replace("index.shtml", f"index_{page_number}.shtml")


def cpic_life_pdf_url(anchor: Any, page_url: str) -> str:
    href = trim(anchor.get("href"))
    if not href or href == "javascript:;":
        return ""
    full_url = urljoin(page_url, href)
    parts = urlsplit(full_url)
    if parts.path.endswith("/mpdfjs/pdf.html"):
        file_path = trim((parse_qs(parts.query).get("file") or [""])[0])
        if file_path:
            return urljoin(CPIC_LIFE_OFFICIAL_BASE_URL, file_path)
    return full_url


def cpic_life_material_type(label: str) -> str:
    return "product_manual" if "产品说明" in label or "说明书" in label else "terms"


def extract_cpic_life_total_pages(html: str) -> int:
    max_page = 1
    for match in re.finditer(r"index_(\d+)\.shtml", html or ""):
        max_page = max(max_page, int(match.group(1)))
    match = re.search(r"/\s*(\d+)\s*页", html or "")
    if match:
        max_page = max(max_page, int(match.group(1)))
    return max_page


def extract_cpic_life_page(category: dict[str, str], page_number: int) -> dict[str, Any]:
    page_url = cpic_life_page_url(category["path"], page_number)
    status, html = fetch_html(page_url)
    page_meta = {
        "url": page_url,
        "status": status,
        "totalPages": extract_cpic_life_total_pages(html),
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if status < 200 or status >= 300 or "产品名称及条款" not in html:
        return {"page": page_meta, "products": [], "tasks": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 5:
            continue
        product_cell = cells[1]
        product_anchor = product_cell.find("a")
        product_name = trim(product_anchor.get_text(" ", strip=True) if product_anchor else product_cell.get_text(" ", strip=True))
        if not product_name:
            continue
        product = {
            "company": "太保寿险",
            "productName": product_name,
            "productType": category["productType"],
            "salesStatus": category["salesStatus"],
            "sourcePage": page_url,
        }
        products.append(product)
        term_seen: set[str] = set()
        for anchor in product_cell.find_all("a"):
            material_url = cpic_life_pdf_url(anchor, page_url)
            if not material_url or material_url in term_seen:
                continue
            term_seen.add(material_url)
            tasks.append(
                {
                    "company": product["company"],
                    "productName": product_name,
                    "productType": product["productType"],
                    "salesStatus": product["salesStatus"],
                    "label": "产品条款",
                    "materialType": "terms",
                    "url": material_url,
                    "pageUrl": page_url,
                }
            )
        manual_cell = cells[4]
        manual_seen: set[str] = set()
        for anchor in manual_cell.find_all("a"):
            label = trim(anchor.get_text(" ", strip=True))
            if "产品说明" not in label and "说明书" not in label:
                continue
            material_url = cpic_life_pdf_url(anchor, page_url)
            if not material_url or material_url in manual_seen:
                continue
            manual_seen.add(material_url)
            tasks.append(
                {
                    "company": product["company"],
                    "productName": product_name,
                    "productType": product["productType"],
                    "salesStatus": product["salesStatus"],
                    "label": label or "产品说明书",
                    "materialType": cpic_life_material_type(label),
                    "url": material_url,
                    "pageUrl": page_url,
                }
            )
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_cpic_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("pageUrl")) or CPIC_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "太保寿险",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"太保寿险官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or cpic_life_material_type(label),
        "official": True,
        "officialDomain": "life.cpic.com.cn",
        "parser": "scrapling_cpic_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_cpic_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_cpic_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_cpic_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_cpic_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "太保寿险"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()
    for category in CPIC_LIFE_PRODUCT_CATEGORIES:
        first = extract_cpic_life_page(category, 1)
        total_pages = int(first["page"].get("totalPages") or 1)
        for page_result in [first] + [extract_cpic_life_page(category, page_number) for page_number in range(2, total_pages + 1)]:
            pages.append(page_result["page"])
            for product in page_result["products"]:
                if max_products and len(products) >= max_products:
                    break
                products.append({**product, "company": company})
            for task in page_result["tasks"]:
                if max_products and len(products) >= max_products and task.get("productName") not in {item["productName"] for item in products[-10:]}:
                    continue
                material_url = trim(task.get("url"))
                if not material_url or material_url in seen_task_urls or material_url in skip_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append({**task, "company": company})
            if max_products and len(products) >= max_products:
                break
        if max_products and len(products) >= max_products:
            break
    if max_products:
        allowed_products = {item["productName"] for item in products}
        tasks = [task for task in tasks if task.get("productName") in allowed_products]
    records = crawl_cpic_life_material_records(tasks, max_workers=max_workers)
    page_record_counts: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("pageUrl")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            page_record_counts[page_url] = page_record_counts.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = page_record_counts.get(page["url"], 0)
    return {
        "ok": True,
        "company": company,
        "source": urljoin(CPIC_LIFE_OFFICIAL_BASE_URL, "/xrsbx/gkxxpl/jbxx/gsgk/jydbxcpmljtk/"),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def aia_life_status_pages(value: str) -> list[dict[str, str]]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return list(AIA_LIFE_PRODUCT_PAGES.values())
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return [AIA_LIFE_PRODUCT_PAGES["available"]]
    if text in {"discontinued", "stopped", "stop", "停售", "停售及其他", "n"}:
        return [AIA_LIFE_PRODUCT_PAGES["discontinued"]]
    return [page for page in AIA_LIFE_PRODUCT_PAGES.values() if page["salesStatus"] == value or page["apiStatus"] == value]


def aia_life_product_type(product_name: str, product_group: str = "") -> str:
    if "重大疾病" in product_name or "癌症" in product_name or "防癌" in product_name or "疾病" in product_name:
        return "健康险"
    if "医疗" in product_name or "护理" in product_name or "津贴" in product_name:
        return "健康险"
    if "意外" in product_name or "交通" in product_name or "旅行" in product_name or "航空" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    if product_group:
        return product_group
    return ""


def aia_life_material_type(label: str) -> str:
    return "product_manual" if "说明" in label else "terms"


def aia_life_signed_post(payload: dict[str, Any], referer: str) -> tuple[int, dict[str, Any]]:
    body_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    request_id = str(uuid.uuid4())
    sign_source = "1qaz@WSX#$%&#" + "".join(sorted(body_text)) + "##" + request_id
    signature = hashlib.md5(sign_source.encode("utf-8")).hexdigest().upper()
    request = urllib.request.Request(
        AIA_LIFE_PRODUCT_LIST_ENDPOINT,
        data=body_text.encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": "https://www.aia.com.cn",
            "Referer": referer,
            "User-Agent": "Mozilla/5.0",
            "x-crp-sign": signature,
            "x-request-id": request_id,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = int(getattr(response, "status", 0) or 0)
            text = response.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as error:
        status = int(error.code or 0)
        text = error.read().decode("utf-8", "ignore")
    except urllib.error.URLError:
        return 0, {}
    try:
        return status, json.loads(text)
    except Exception:
        return status, {}


def aia_life_pdf_url(file_name: str) -> str:
    value = trim(file_name)
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        url = value
    elif value.startswith("/"):
        url = urljoin(AIA_LIFE_OFFICIAL_BASE_URL, value)
    else:
        url = urljoin(AIA_LIFE_PUBLIC_DISCLOSURE_DOC_BASE_URL, value)
    if not urlsplit(url).path.lower().endswith(".pdf"):
        url = f"{url}.pdf"
    return quote_url(url)


def aia_life_material_tasks(product: dict[str, Any], source_page: str, company: str) -> list[dict[str, str]]:
    product_name = trim(product.get("productName"))
    if not product_name:
        return []
    product_group = trim(product.get("productGroup"))
    product_type = aia_life_product_type(product_name, product_group)
    sales_status = trim(product.get("productStatus")) or trim(product.get("salesStatus"))
    materials = [
        ("产品条款", "terms", trim(product.get("productItem"))),
        ("产品说明书", "product_manual", trim(product.get("productInstruction"))),
    ]
    tasks: list[dict[str, str]] = []
    seen: set[str] = set()
    for label, material, file_name in materials:
        material_url = aia_life_pdf_url(file_name)
        if not material_url or material_url in seen:
            continue
        seen.add(material_url)
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "label": label,
                "materialType": material,
                "url": material_url,
                "sourcePage": source_page,
            }
        )
    return tasks


def crawl_aia_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    label = trim(task.get("label"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or AIA_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    return {
        "company": trim(task.get("company")) or "友邦人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"友邦人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or aia_life_material_type(label),
        "official": True,
        "officialDomain": "www.aia.com.cn",
        "parser": "scrapling_aia_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_aia_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_aia_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_aia_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_aia_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "友邦人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    page_size = max(1, min(100, int(payload.get("pageSize") or 100)))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    status_pages = aia_life_status_pages(trim(payload.get("saleStatus") or payload.get("status")))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_product_keys: set[str] = set()
    seen_task_urls: set[str] = set()

    for page_info in status_pages:
        page_index = 0
        while True:
            request_payload = {"like": "", "status": page_info["apiStatus"], "page": {"pageSize": str(page_size), "index": page_index}}
            status, data = aia_life_signed_post(request_payload, referer=page_info["url"])
            product_publish = data.get("product_publish") if isinstance(data, dict) else {}
            page_records = product_publish.get("records") if isinstance(product_publish, dict) else []
            if not isinstance(page_records, list):
                page_records = []
            page_meta = {
                "url": page_info["url"],
                "api": AIA_LIFE_PRODUCT_LIST_ENDPOINT,
                "status": status,
                "salesStatus": page_info["salesStatus"],
                "pageIndex": page_index,
                "total": product_publish.get("total") if isinstance(product_publish, dict) else None,
                "totalPages": product_publish.get("totalPage") if isinstance(product_publish, dict) else None,
                "productCount": 0,
                "materialTaskCount": 0,
                "recordCount": 0,
            }
            pages.append(page_meta)
            if status < 200 or status >= 300 or data.get("success") != "true":
                page_meta["ok"] = False
                break

            for product in page_records:
                product_name = trim(product.get("productName"))
                if not product_name:
                    continue
                product_key = f"{page_info['salesStatus']}|{product_name}"
                if max_products and len(seen_product_keys) >= max_products and product_key not in seen_product_keys:
                    continue
                if product_key not in seen_product_keys:
                    seen_product_keys.add(product_key)
                    products.append(
                        {
                            "company": company,
                            "productName": product_name,
                            "productType": aia_life_product_type(product_name, trim(product.get("productGroup"))),
                            "salesStatus": trim(product.get("productStatus")) or page_info["salesStatus"],
                            "sourcePage": page_info["url"],
                            "productGroup": trim(product.get("productGroup")),
                        }
                    )
                for task in aia_life_material_tasks(product, page_info["url"], company):
                    task_url = trim(task.get("url"))
                    if not task_url or task_url in seen_task_urls or task_url in skip_urls:
                        continue
                    seen_task_urls.add(task_url)
                    tasks.append(task)
            page_meta["productCount"] = len(page_records)
            page_meta["materialTaskCount"] = len(tasks)

            total_pages = int(product_publish.get("totalPage") or 0)
            page_index += 1
            if max_products and len(seen_product_keys) >= max_products:
                break
            if not page_records or (total_pages and page_index >= total_pages):
                break
        if max_products and len(seen_product_keys) >= max_products:
            break

    records = crawl_aia_life_material_records(tasks, max_workers=max_workers)
    record_count_by_source: dict[str, int] = {}
    source_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        source = source_by_url.get(trim(record.get("url")))
        if source:
            record_count_by_source[source] = record_count_by_source.get(source, 0) + 1
    for page in pages:
        page["recordCount"] = record_count_by_source.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": AIA_LIFE_PRODUCT_LIST_ENDPOINT,
        "statusPages": status_pages,
        "pageSize": page_size,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def ccb_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return {"在售"}
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return {"停售"}
    return {"在售", "停售"}


def ccb_life_material_type(label: str) -> str:
    return "product_manual" if "说明书" in label else "terms"


def ccb_life_keep_material(label: str) -> bool:
    return "产品条款" in label or "产品说明书" in label


def ccb_life_pdf_url(anchor: Any) -> str:
    href = trim(anchor.get("href"))
    if not href:
        return ""
    href = html_lib.unescape(href)
    full_url = urljoin(CCB_LIFE_OFFICIAL_BASE_URL, href)
    parts = urlsplit(full_url)
    path = parts.path.replace("/home/ap/elife/nas/clos/", "/")
    if not path.startswith("/html/6182/static/attach/"):
        return ""
    return urlunsplit((parts.scheme or "https", parts.netloc or CCB_LIFE_OFFICIAL_DOMAIN, path, parts.query, ""))


def fetch_ccb_life_html(url: str) -> tuple[int, str]:
    for _ in range(3):
        proc = subprocess.run(
            [
                "curl",
                "--http1.1",
                "-L",
                "--compressed",
                "-sS",
                "--connect-timeout",
                "10",
                "--max-time",
                "45",
                "--user-agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
                "-H",
                f"Referer: {CCB_LIFE_OFFICIAL_BASE_URL}",
                quote_url(url),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=55,
        )
        if proc.returncode == 0 and proc.stdout:
            html = proc.stdout.decode("utf-8", "ignore")
            if "产品基本信息" in html and "data-type=" in html:
                return 200, html
    try:
        return fetch_html(url)
    except Exception:
        return 0, ""


def extract_ccb_life_product_page(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "建信人寿"
    allowed_status = ccb_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    status, html = fetch_ccb_life_html(CCB_LIFE_PRODUCT_INFO_URL)
    page_meta = {
        "url": CCB_LIFE_PRODUCT_INFO_URL,
        "status": status,
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if status < 200 or status >= 300 or "产品基本信息" not in html:
        return {"page": page_meta, "products": [], "tasks": []}

    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in soup.select("#data p[data-type][data-cl][data-name]"):
        product_name = trim(row.get("data-name"))
        if not product_name or "删除" in product_name:
            continue
        sales_status = trim(row.get("data-type"))
        if sales_status not in allowed_status:
            continue
        product_type = trim(row.get("data-cl"))
        product = {
            "company": company,
            "productName": product_name,
            "productType": product_type,
            "salesStatus": sales_status,
            "sourcePage": CCB_LIFE_PRODUCT_INFO_URL,
        }
        products.append(product)
        for anchor in row.find_all("a"):
            label = trim(anchor.get_text(" ", strip=True))
            if not ccb_life_keep_material(label):
                continue
            material_url = ccb_life_pdf_url(anchor)
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "label": label,
                    "materialType": ccb_life_material_type(label),
                    "url": material_url,
                    "pageUrl": CCB_LIFE_PRODUCT_INFO_URL,
                }
            )
        if max_products and len(products) >= max_products:
            break

    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_ccb_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("pageUrl")) or CCB_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "建信人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"建信人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or ccb_life_material_type(label),
        "official": True,
        "officialDomain": CCB_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_ccb_life_product_info",
    }


def crawl_ccb_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_ccb_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_ccb_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_ccb_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "建信人寿"
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    page_result = extract_ccb_life_product_page({**payload, "company": company})
    tasks = page_result["tasks"]
    records = crawl_ccb_life_material_records(tasks, max_workers=max_workers)
    page_meta = page_result["page"]
    page_meta["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": CCB_LIFE_PRODUCT_INFO_URL,
        "maxWorkers": max_workers,
        "pages": [page_meta],
        "products": page_result["products"],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def minsheng_life_status_pages(value: str) -> list[dict[str, Any]]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return MINSHENG_LIFE_PRODUCT_CATEGORIES
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return [page for page in MINSHENG_LIFE_PRODUCT_CATEGORIES if page["onSale"]]
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return [page for page in MINSHENG_LIFE_PRODUCT_CATEGORIES if not page["onSale"]]
    if text in {"individual", "personal", "个险"}:
        return [page for page in MINSHENG_LIFE_PRODUCT_CATEGORIES if page["insuranceFlag"] == "0"]
    if text in {"group", "团险"}:
        return [page for page in MINSHENG_LIFE_PRODUCT_CATEGORIES if page["insuranceFlag"] == "1"]
    return [page for page in MINSHENG_LIFE_PRODUCT_CATEGORIES if page["salesStatus"].startswith(value) or page["salesStatus"] == value]


def minsheng_life_product_type(product_name: str, classify: str = "", insurance_flag: str = "") -> str:
    if "团体" in product_name or insurance_flag == "1":
        return "团体保险"
    if any(keyword in product_name for keyword in ("重大疾病", "疾病", "医疗", "护理", "癌症", "防癌", "健康")):
        return "健康保险"
    if any(keyword in product_name for keyword in ("意外", "交通", "驾乘", "旅行")):
        return "意外保险"
    if any(keyword in product_name for keyword in ("年金", "养老")):
        return "年金保险"
    if any(keyword in product_name for keyword in ("两全", "终身寿险", "定期寿险", "寿险")):
        return "人寿保险"
    return trim(classify)


def minsheng_life_material_type(label: str) -> str:
    return "product_manual" if "说明书" in label else "terms"


def minsheng_life_post_product_page(payload: dict[str, Any], referer: str) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(
        [
            "curl",
            "-L",
            "--compressed",
            "-sS",
            "--connect-timeout",
            "10",
            "--max-time",
            "35",
            "--user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
            "-H",
            "Content-Type: application/json;charset=utf-8",
            "-H",
            "Origin: https://www.minshenglife.com",
            "-H",
            f"Referer: {referer}",
            "-X",
            "POST",
            "--data-binary",
            "@-",
            MINSHENG_LIFE_PRODUCT_LIST_ENDPOINT,
        ],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=45,
    )
    if proc.returncode != 0:
        return 0, {}
    try:
        return 200, json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return 200, {}


def minsheng_life_product_material_tasks(product: dict[str, Any], page_info: dict[str, Any], company: str) -> list[dict[str, str]]:
    product_name = trim(product.get("productName"))
    if not product_name:
        return []
    product_type = minsheng_life_product_type(
        product_name,
        trim(product.get("productClassify")),
        trim(product.get("insuranceFlag") or page_info.get("insuranceFlag")),
    )
    tasks: list[dict[str, str]] = []
    for label, url_key, name_key in [
        ("产品条款", "productTermsAttachUrl", "productTermsAttachName"),
        ("产品说明书", "productDespAttachUrl", "productDespAttachName"),
    ]:
        href = trim(product.get(url_key))
        if not href:
            continue
        material_url = urljoin(MINSHENG_LIFE_OFFICIAL_BASE_URL, html_lib.unescape(href))
        if not urlsplit(material_url).netloc.endswith("minshenglife.com"):
            continue
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": trim(page_info.get("salesStatus")),
                "productClassify": trim(product.get("productClassify")),
                "productRiskLevel": trim(product.get("productRiskLevel")),
                "publishTime": trim(product.get("publishTime") or product.get("createDate")),
                "label": label,
                "materialName": trim(product.get(name_key)),
                "materialType": minsheng_life_material_type(label),
                "url": material_url,
                "pageUrl": urljoin(MINSHENG_LIFE_OFFICIAL_BASE_URL, trim(page_info.get("path"))),
            }
        )
    return tasks


def crawl_minsheng_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("pageUrl")) or MINSHENG_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    product_classify = trim(task.get("productClassify"))
    risk_level = trim(task.get("productRiskLevel"))
    publish_time = trim(task.get("publishTime"))
    details = "，".join(item for item in [f"官网{label}", f"产品分类{product_classify}" if product_classify else "", f"风险等级{risk_level}" if risk_level else "", f"发布时间{publish_time}" if publish_time else ""] if item)
    return {
        "company": trim(task.get("company")) or "民生人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"民生人寿{details}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or minsheng_life_material_type(label),
        "official": True,
        "officialDomain": MINSHENG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_minsheng_life_product_info",
    }


def crawl_minsheng_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_minsheng_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_minsheng_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_minsheng_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "民生人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    page_size = max(1, int(payload.get("pageSize") or 100))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status_pages = minsheng_life_status_pages(trim(payload.get("saleStatus") or payload.get("status")))
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for page_info in status_pages:
        source_page = urljoin(MINSHENG_LIFE_OFFICIAL_BASE_URL, trim(page_info.get("path")))
        page_no = 1
        total_pages = 1
        page_meta = {
            "url": source_page,
            "status": 0,
            "salesStatus": trim(page_info.get("salesStatus")),
            "productCount": 0,
            "materialTaskCount": 0,
            "totalPages": 0,
            "totalElements": 0,
        }
        while page_no <= total_pages:
            request_payload = {
                "onSale": bool(page_info.get("onSale")),
                "pageNo": page_no,
                "pageSize": page_size,
                "insuranceFlag": trim(page_info.get("insuranceFlag")),
                "productName": "",
            }
            status, data = minsheng_life_post_product_page(request_payload, referer=source_page)
            page_meta["status"] = status
            result = data.get("result") if isinstance(data, dict) else {}
            if status < 200 or status >= 300 or not isinstance(result, dict):
                break
            content = result.get("content") if isinstance(result.get("content"), list) else []
            total_pages = int(result.get("totalPages") or 1)
            page_meta["totalPages"] = total_pages
            page_meta["totalElements"] = int(result.get("totalElements") or 0)

            for product in content:
                if not isinstance(product, dict):
                    continue
                product_name = trim(product.get("productName"))
                if not product_name:
                    continue
                product_type = minsheng_life_product_type(
                    product_name,
                    trim(product.get("productClassify")),
                    trim(product.get("insuranceFlag") or page_info.get("insuranceFlag")),
                )
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": trim(page_info.get("salesStatus")),
                        "sourcePage": source_page,
                    }
                )
                for task in minsheng_life_product_material_tasks(product, page_info, company):
                    material_url = trim(task.get("url"))
                    if not material_url or material_url in seen_urls:
                        continue
                    seen_urls.add(material_url)
                    tasks.append(task)
                if max_products and len(products) >= max_products:
                    break

            if max_products and len(products) >= max_products:
                break
            if not content:
                break
            page_no += 1

        page_meta["productCount"] = len([product for product in products if product.get("sourcePage") == source_page])
        page_meta["materialTaskCount"] = len([task for task in tasks if task.get("pageUrl") == source_page])
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    records = crawl_minsheng_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        source_url = trim(record.get("url"))
        for task in tasks:
            if trim(task.get("url")) == source_url:
                page_url = trim(task.get("pageUrl"))
                record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
                break
    for page_meta in pages:
        page_meta["recordCount"] = record_counts_by_page.get(page_meta["url"], 0)

    return {
        "ok": True,
        "company": company,
        "source": "https://www.minshenglife.com/articleview/53",
        "officialDomain": MINSHENG_LIFE_OFFICIAL_DOMAIN,
        "pageSize": page_size,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def cathay_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {page["salesStatus"] for page in CATHAY_LIFE_PRODUCT_PAGES}
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return {"在售"}
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return {page["salesStatus"] for page in CATHAY_LIFE_PRODUCT_PAGES if page["salesStatus"].startswith("停售")}
    if "历史" in value:
        return {"停售（历史：2023年6月30日前）"}
    return {page["salesStatus"] for page in CATHAY_LIFE_PRODUCT_PAGES if page["salesStatus"].startswith(value) or page["salesStatus"] == value}


def cathay_life_product_type(product_name: str, category: str = "") -> str:
    if category:
        return category
    if "重大疾病" in product_name or "癌症" in product_name or "防癌" in product_name or "疾病" in product_name:
        return "健康保险"
    if "医疗" in product_name or "护理" in product_name or "特定药品" in product_name or "津贴" in product_name:
        return "健康保险"
    if "意外" in product_name or "交通" in product_name or "旅行" in product_name or "驾乘" in product_name:
        return "意外保险"
    if "年金" in product_name or "养老" in product_name:
        return "年金保险"
    if "两全" in product_name or "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "人寿保险"
    if "团体" in product_name:
        return "团体保险"
    return ""


def cathay_life_material_type(label: str) -> str:
    if "说明" in label:
        return "product_manual"
    return "terms"


def cathay_life_keep_material(label: str, url: str) -> bool:
    if not label or not url:
        return False
    if ".pdf" not in url.lower():
        return False
    if "规则" in label or EXCLUDED_MATERIAL_RE.search(label):
        return False
    return "条款" in label or "产品说明" in label or "说明文档" in label or "说明书" in label or label == "文件下载"


def fetch_pdf_bytes_with_cookies(url: str, *, referer: str, cookie_header: str) -> tuple[int, str, bytes]:
    with tempfile.NamedTemporaryFile(prefix="cathaylife-pdf-", suffix=".pdf") as body_file, tempfile.NamedTemporaryFile(
        prefix="cathaylife-headers-", suffix=".txt"
    ) as header_file:
        args = [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "--max-time",
            "45",
            "--user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "-H",
            "Accept: application/pdf,*/*",
            "-H",
            f"Referer: {referer or CATHAY_LIFE_OFFICIAL_BASE_URL}",
            "-H",
            f"Cookie: {cookie_header}",
            "-D",
            header_file.name,
            "-o",
            body_file.name,
            quote_url(url),
        ]
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=55)
        data = body_file.read()
        headers = header_file.read().decode("utf-8", "ignore")
    statuses = [int(match.group(1)) for match in re.finditer(r"HTTP/\S+\s+(\d+)", headers)]
    content_types = re.findall(r"(?im)^content-type:\s*([^\r\n]+)", headers)
    status = statuses[-1] if statuses else (200 if proc.returncode == 0 else 0)
    content_type = trim(content_types[-1]) if content_types else ""
    return status, content_type, data[: MAX_PDF_BYTES + 1]


def fetch_bytes_with_cathay_cookies(url: str, *, referer: str, cookie_header: str, max_bytes: int = MAX_PDF_BYTES) -> tuple[int, str, bytes]:
    with tempfile.NamedTemporaryFile(prefix="cathaylife-body-", suffix=".bin") as body_file, tempfile.NamedTemporaryFile(
        prefix="cathaylife-headers-", suffix=".txt"
    ) as header_file:
        args = [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "--max-time",
            "60",
            "--user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "-H",
            "Accept: application/zip,application/pdf,*/*",
            "-H",
            f"Referer: {referer or CATHAY_LIFE_OFFICIAL_BASE_URL}",
            "-H",
            f"Cookie: {cookie_header}",
            "-D",
            header_file.name,
            "-o",
            body_file.name,
            quote_url(url),
        ]
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=70)
        data = body_file.read()
        headers = header_file.read().decode("utf-8", "ignore")
    statuses = [int(match.group(1)) for match in re.finditer(r"HTTP/\S+\s+(\d+)", headers)]
    content_types = re.findall(r"(?im)^content-type:\s*([^\r\n]+)", headers)
    status = statuses[-1] if statuses else (200 if proc.returncode == 0 else 0)
    content_type = trim(content_types[-1]) if content_types else ""
    return status, content_type, data[: max_bytes + 1]


def read_cathay_life_cookie_header() -> str:
    try:
        return trim(open(runtime_path("cathaylife-cookies.txt"), encoding="utf-8").read())
    except Exception:
        return ""


async def cathay_life_extract_page(playwright: Any, page_info: dict[str, str], *, user_data_dir: str, headless: bool) -> dict[str, Any]:
    browser = await playwright.chromium.launch_persistent_context(
        user_data_dir,
        headless=headless,
        executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        args=["--no-first-run", "--disable-blink-features=AutomationControlled"],
        viewport={"width": 1280, "height": 900},
    )
    try:
        page = await browser.new_page()
        response = await page.goto(page_info["url"], wait_until="networkidle", timeout=60000)
        text = await page.locator("body").inner_text(timeout=10000)
        status = response.status if response else 0
        if status == 405 or "确认您是真人" in text or "正在验证您是否是真人" in text or "需要先检查您的连接" in text:
            cookies = await browser.cookies(CATHAY_LIFE_OFFICIAL_BASE_URL)
            return {
                "ok": False,
                "code": "CATHAY_LIFE_HUMAN_VERIFICATION_REQUIRED",
                "url": page_info["url"],
                "status": status,
                "salesStatus": page_info["salesStatus"],
                "rows": [],
                "cookieHeader": "; ".join(f"{cookie['name']}={cookie['value']}" for cookie in cookies),
            }
        rows = await page.evaluate(
            """() => Array.from(document.querySelectorAll('table')).flatMap((table, tableIndex) => {
              const tableHeader = Array.from(table.querySelectorAll('tr:first-child th, tr:first-child td')).map((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim()).join(' ');
              return Array.from(table.querySelectorAll('tr')).slice(1).map((row) => {
                const cells = Array.from(row.querySelectorAll('td'));
                if (cells.length < 2) return null;
                const materialsCell = cells[1];
                return {
                  tableIndex,
                  tableHeader,
                  productName: (cells[0].innerText || '').replace(/\s+/g, ' ').trim(),
                  productClass: (cells[2]?.innerText || '').replace(/\s+/g, ' ').trim(),
                  rawText: row.innerText || '',
                  materials: Array.from(materialsCell.querySelectorAll('a')).map((anchor) => ({
                    label: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim(),
                    url: anchor.href || '',
                  })),
                };
              }).filter(Boolean);
            })"""
        )
        cookies = await browser.cookies(CATHAY_LIFE_OFFICIAL_BASE_URL)
        return {
            "ok": True,
            "url": page_info["url"],
            "status": status,
            "salesStatus": page_info["salesStatus"],
            "rows": rows,
            "cookieHeader": "; ".join(f"{cookie['name']}={cookie['value']}" for cookie in cookies),
        }
    finally:
        await browser.close()


async def cathay_life_extract_pages_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": []}
    status_filter = cathay_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    user_data_dir = trim(payload.get("userDataDir")) or "/tmp/chrome-cathaylife-crawl"
    headless_value = trim(payload.get("headless"))
    headless = headless_value.lower() not in {"0", "false", "no", "headed"}
    pages: list[dict[str, Any]] = []
    async with async_playwright() as playwright:
        for page_info in CATHAY_LIFE_PRODUCT_PAGES:
            if page_info["salesStatus"] not in status_filter:
                continue
            pages.append(await cathay_life_extract_page(playwright, page_info, user_data_dir=user_data_dir, headless=headless))
    return {"ok": True, "pages": pages}


def cathay_life_extract_pages(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(cathay_life_extract_pages_async(payload))


async def cathay_life_extract_filing_page_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": []}
    user_data_dir = trim(payload.get("userDataDir")) or "/tmp/chrome-cathaylife-crawl"
    headless_value = trim(payload.get("headless"))
    headless = headless_value.lower() not in {"0", "false", "no", "headed"}
    async with async_playwright() as playwright:
        page = await cathay_life_extract_page(
            playwright,
            {"url": CATHAY_LIFE_FILING_URL, "salesStatus": "备案信息"},
            user_data_dir=user_data_dir,
            headless=headless,
        )
    return {"ok": True, "pages": [page]}


def cathay_life_extract_filing_page(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(cathay_life_extract_filing_page_async(payload))


def crawl_cathay_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    label = trim(task.get("label"))
    if not cathay_life_keep_material(label, material_url):
        return None
    pdf_status, content_type, data = fetch_pdf_bytes_with_cookies(
        material_url,
        referer=trim(task.get("sourcePage")) or CATHAY_LIFE_OFFICIAL_BASE_URL,
        cookie_header=trim(task.get("cookieHeader")),
    )
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    return {
        "company": trim(task.get("company")) or "陆家嘴国泰人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"陆家嘴国泰官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or cathay_life_material_type(label),
        "official": True,
        "officialDomain": "www.cathaylife.cn",
        "parser": "scrapling_cathay_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
    }


def crawl_cathay_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_cathay_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_cathay_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_cathay_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "陆家嘴国泰人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    extracted = cathay_life_extract_pages(payload)
    if not extracted.get("ok"):
        return {**extracted, "company": company, "products": [], "records": []}

    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_tasks: set[str] = set()

    for page_result in extracted.get("pages", []):
        page_meta = {
            "url": page_result.get("url"),
            "status": page_result.get("status"),
            "salesStatus": page_result.get("salesStatus"),
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if not page_result.get("ok"):
            return {
                "ok": False,
                "code": page_result.get("code") or "CATHAY_LIFE_PAGE_FAILED",
                "message": "陆家嘴国泰官网产品页返回人机校验或不可用，需要打开真实浏览器完成验证后重试。",
                "company": company,
                "pages": [{**page_meta, "ok": False, "code": page_result.get("code")}],
                "products": [],
                "records": [],
            }
        rows = page_result.get("rows") if isinstance(page_result.get("rows"), list) else []
        product_categories: dict[str, str] = {}
        for row in rows:
            product_name = trim(row.get("productName"))
            category = CATHAY_LIFE_TABLE_CATEGORIES.get(int(row.get("tableIndex") or 0), "")
            if product_name and category:
                product_categories[product_name] = category
        for row in rows:
            product_name = trim(row.get("productName"))
            if not product_name:
                continue
            product_key = f"{page_result.get('salesStatus')}|{product_name}"
            if max_products and len(seen_products) >= max_products and product_key not in seen_products:
                continue
            category = product_categories.get(product_name) or CATHAY_LIFE_TABLE_CATEGORIES.get(int(row.get("tableIndex") or 0), "")
            product_type = cathay_life_product_type(product_name, category)
            if product_key not in seen_products:
                seen_products.add(product_key)
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": trim(page_result.get("salesStatus")),
                        "sourcePage": trim(page_result.get("url")),
                        "productClass": trim(row.get("productClass")),
                    }
                )
            for material in row.get("materials") or []:
                label = trim(material.get("label"))
                material_url = trim(material.get("url"))
                table_header = trim(row.get("tableHeader"))
                if label == "文件下载" and "产品条款" in table_header:
                    label = "产品条款"
                if not cathay_life_keep_material(label, material_url):
                    continue
                task_key = f"{product_key}|{material_url}"
                if task_key in seen_tasks:
                    continue
                seen_tasks.add(task_key)
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": trim(page_result.get("salesStatus")),
                        "label": label,
                        "materialType": cathay_life_material_type(label),
                        "url": material_url,
                        "sourcePage": trim(page_result.get("url")),
                        "cookieHeader": trim(page_result.get("cookieHeader")),
                    }
                )
        page_meta["productCount"] = len([product for product in products if product.get("sourcePage") == page_result.get("url")])
        page_meta["materialTaskCount"] = len([task for task in tasks if task.get("sourcePage") == page_result.get("url")])
        pages.append(page_meta)

    records = crawl_cathay_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": CATHAY_LIFE_OFFICIAL_BASE_URL,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def union_life_source_pages(value: str) -> list[dict[str, str]]:
    selected = {item.strip().lower() for item in re.split(r"[,，\s]+", trim(value)) if item.strip()}
    if not selected or "all" in selected:
        return UNION_LIFE_PRODUCT_PAGES
    return [
        page
        for page in UNION_LIFE_PRODUCT_PAGES
        if page["key"].lower() in selected or page["salesStatus"].lower() in selected
    ]


def union_life_fix_legacy_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.netloc.lower() == "unionlife":
        return urlunsplit(("https", UNION_LIFE_OFFICIAL_DOMAIN, parts.path, parts.query, parts.fragment))
    return url


def union_life_material_url(href: str, page_url: str) -> str:
    url = union_life_fix_legacy_url(urljoin(page_url, trim(href)))
    parts = urlsplit(url)
    if "/pdfjs/web/viewer.html" in parts.path:
        file_values = parse_qs(parts.query).get("file") or []
        if file_values:
            return union_life_fix_legacy_url(urljoin(UNION_LIFE_OFFICIAL_BASE_URL, file_values[0]))
    return url


def union_life_is_official_url(url: str) -> bool:
    hostname = trim(urlsplit(url).hostname).lower()
    return hostname == "unionlife.com.cn" or hostname.endswith(".unionlife.com.cn")


def union_life_is_material_url(url: str) -> bool:
    lowered = trim(url).lower()
    return ".pdf" in lowered or "/resource/download" in lowered or "download?id=" in lowered


def union_life_material_type(label: str, url: str) -> str:
    text = f"{label} {url}"
    if UNION_LIFE_EXCLUDED_MATERIAL_RE.search(text):
        return ""
    if "说明书" in text or "产品说明" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def union_life_product_name_from_label(label: str) -> str:
    value = clean_text(trim(label).replace("《", "").replace("》", ""))
    value = re.sub(r"^\d+\s*[-_、.]\s*", "", value)
    value = re.sub(r"(?:产品说明书|产品说明|保险条款|条款)\s*$", "", value)
    return clean_text(value)


def union_life_cell_product_name(cells: list[Any]) -> str:
    header_re = re.compile(r"产品名称|实际销售名称|备案产品名称|条款|说明书|销售区域|备案编号|报备文件|序号|产品中心")
    for cell in cells[:3]:
        value = clean_text(cell.get_text(" ", strip=True).replace("《", "").replace("》", ""))
        if not value or len(value) > 80:
            continue
        if header_re.search(value):
            continue
        if UNION_LIFE_EXCLUDED_MATERIAL_RE.search(value):
            continue
        if "合众" in value:
            return union_life_product_name_from_label(value)
    return ""


def union_life_product_type(product_name: str) -> str:
    return taikang_life_product_type(product_name)


def union_life_focused_responsibility_excerpt(text: str) -> str:
    normalized = clean_text(text)
    if not normalized:
        return ""
    starts: list[int] = []
    strict_patterns = [
        r"【\s*保险责任\s*】",
        r"(?:\d+(?:\.\d+)+|第[一二三四五六七八九十百]+条)\s*保险责任\s*(?=在本|在保险|本公司|我们|被保险人)",
        r"保险责任\s*(?=在本(?:主)?合同保险期间内|在保险期间内)",
    ]
    for strict_pattern in strict_patterns:
        for match in re.finditer(strict_pattern, normalized):
            starts.append(match.start())
    if starts:
        start = starts[0]
    else:
        pattern = re.compile(r"(?:第[一二三四五六七八九十百]+条\s*)?(?:\d+(?:\.\d+)+\s*)?保险责任")
        body_markers = [normalized.find(marker) for marker in ["在本条款中", "您与我们的合同", "1.1 投保范围"]]
        body_start = min([index for index in body_markers if index >= 0], default=0)
        later_matches = [match.start() for match in pattern.finditer(normalized) if match.start() > body_start + 300]
        start = later_matches[0] if later_matches else normalized.find("保险责任")
    if start < 0:
        return ""
    tail = normalized[start:]
    end_match = re.search(
        r"(?:第[一二三四五六七八九十百]+条\s*)?(?:\d+(?:\.\d+)+\s*)?(?:保险责任的免除|责任免除|其他免责条款|如何申请领取保险金|保险金申请|释义)",
        tail[100:],
    )
    excerpt = tail[: 100 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
    return excerpt[:MAX_EXCERPT_CHARS].strip()


def union_life_page_products(
    company: str,
    page_info: dict[str, str],
    html: str,
    seen_product_keys: set[str],
    max_products: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()
    for row in soup.find_all("tr"):
        if max_products and len(seen_product_keys) >= max_products:
            break
        cells = row.find_all(["td", "th"])
        if not cells:
            continue
        row_product = union_life_cell_product_name(cells)
        row_tasks: list[dict[str, str]] = []
        for anchor in row.find_all("a"):
            label = clean_text(trim(anchor.get("title")) or anchor.get_text(" ", strip=True))
            href = trim(anchor.get("href"))
            material_url = union_life_material_url(href, page_info["url"])
            material = union_life_material_type(label, material_url)
            if not material or not union_life_is_material_url(material_url):
                continue
            if not union_life_is_official_url(material_url):
                continue
            product_name = row_product
            if not product_name or not product_matches(product_name, label):
                product_name = union_life_product_name_from_label(label)
            if not product_name or "合众" not in product_name:
                continue
            if material_url in seen_task_urls:
                continue
            seen_task_urls.add(material_url)
            row_tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": union_life_product_type(product_name),
                    "salesStatus": page_info["salesStatus"],
                    "label": label,
                    "materialType": material,
                    "url": material_url,
                    "pageUrl": page_info["url"],
                }
            )
        if not row_tasks:
            continue
        for task in row_tasks:
            product_key = f"{task['salesStatus']}|{task['productName']}"
            if product_key not in seen_product_keys:
                seen_product_keys.add(product_key)
                products.append(
                    {
                        "company": company,
                        "productName": task["productName"],
                        "productType": task["productType"],
                        "salesStatus": task["salesStatus"],
                        "sourcePage": page_info["url"],
                        "pageKey": page_info["key"],
                    }
                )
        tasks.extend(row_tasks)
    return products, tasks


def crawl_union_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes(material_url)
    if pdf_status < 200 or pdf_status >= 300 or not data.startswith(b"%PDF"):
        pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("pageUrl")))
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = union_life_focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")),
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": label or f"{product_name}产品资料",
        "url": material_url,
        "snippet": f"合众人寿官网{label or '产品资料'}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": UNION_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_union_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_union_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_union_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_union_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_union_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "合众人寿"
    source_scope = trim(payload.get("sourceScope") or payload.get("source") or "all")
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or 6))
    selected_pages = union_life_source_pages(source_scope)
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    for page_info in selected_pages:
        status, html = fetch_html(page_info["url"])
        page_meta = {
            "key": page_info["key"],
            "url": page_info["url"],
            "status": status,
            "salesStatus": page_info["salesStatus"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            continue
        page_products, page_tasks = union_life_page_products(company, page_info, html, seen_products, max_products)
        page_task_count = 0
        for task in page_tasks:
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
            page_task_count += 1
        page_meta["productCount"] = len(page_products)
        page_meta["materialTaskCount"] = page_task_count
        pages.append(page_meta)
        products.extend(page_products)
        if max_products and len(seen_products) >= max_products:
            break
    records = crawl_union_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("pageUrl")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(page["url"], 0)
    return {
        "ok": True,
        "company": company,
        "source": UNION_LIFE_OFFICIAL_BASE_URL,
        "sourceScope": source_scope,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def china_united_life_official_domain(material_url: str) -> str:
    hostname = (urlsplit(material_url).hostname or "").lower()
    for domain in sorted(CHINA_UNITED_LIFE_OFFICIAL_DOMAINS):
        if hostname == domain or hostname.endswith(f".{domain}"):
            return domain
    return ""


def china_united_life_is_official_url(material_url: str) -> bool:
    return bool(china_united_life_official_domain(material_url))


def china_united_life_source_profiles(source: str, sale_status: str) -> list[dict[str, str]]:
    source_value = trim(source).lower() or "all"
    status_value = trim(sale_status).lower() or "all"
    profiles = list(CHINA_UNITED_LIFE_PRODUCT_PROFILES)
    if source_value in {"product-info", "base", "basic"}:
        profiles = [item for item in profiles if item["sourceGroup"] == "product-info"]
    elif source_value in {"new", "new-type", "x"}:
        profiles = [item for item in profiles if item["sourceGroup"] == "new-type"]
    if status_value in {"sale", "selling", "insale", "in_sale", "0", "在售"}:
        profiles = [item for item in profiles if item["status"] == "0"]
    elif status_value in {"stop", "stopped", "停售", "1"}:
        profiles = [item for item in profiles if item["status"] == "1"]
    return profiles


def fetch_china_united_life_product_page(profile: dict[str, str], page_size: int, page_number: int) -> tuple[int, dict[str, Any]]:
    endpoint = f"{CHINA_UNITED_LIFE_PRODUCT_INFO_ENDPOINT}/{page_size}/{page_number}/{profile['prop']}/{profile['status']}"
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "-X",
            "POST",
            "--max-time",
            "35",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            "Content-Type: application/json; charset=utf-8",
            "-H",
            f"Referer: {profile['sourcePage']}",
            "--data",
            "",
            endpoint,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=45,
    )
    status = 200 if proc.returncode == 0 else 0
    try:
        return status, json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return status, {}


def china_united_life_product_from_item(company: str, profile: dict[str, str], item: dict[str, Any]) -> dict[str, str] | None:
    product_name = trim(item.get("product_name"))
    if not product_name:
        return None
    return {
        "company": company,
        "productName": product_name,
        "productType": trim(item.get("product_classify")),
        "salesStatus": profile["salesStatus"],
        "sourcePage": profile["sourcePage"],
        "sourceProfile": profile["label"],
        "productId": trim(item.get("id")),
        "productProp": trim(item.get("product_prop")),
        "recordNo": trim(item.get("public_record_no")),
    }


def china_united_life_material_tasks_from_item(company: str, profile: dict[str, str], item: dict[str, Any]) -> list[dict[str, str]]:
    product = china_united_life_product_from_item(company, profile, item)
    if not product:
        return []
    product_name = product["productName"]
    product_type = product["productType"]
    record_no = product["recordNo"]
    tasks: list[dict[str, str]] = []
    record_url = urljoin(CHINA_UNITED_LIFE_OFFICIAL_BASE_URL, trim(item.get("public_record_url")))
    if record_url and china_united_life_is_official_url(record_url):
        source_kind = "archive" if record_url.lower().endswith((".rar", ".zip")) else "pdf"
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": product["salesStatus"],
                "sourcePage": profile["sourcePage"],
                "sourceProfile": profile["label"],
                "url": record_url,
                "label": "保险条款",
                "materialType": "terms",
                "sourceKind": source_kind,
                "recordNo": record_no,
            }
        )
    desc_url = urljoin(CHINA_UNITED_LIFE_OFFICIAL_BASE_URL, trim(item.get("publicDescAddress")))
    if desc_url and desc_url.lower().endswith(".pdf") and china_united_life_is_official_url(desc_url):
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": product["salesStatus"],
                "sourcePage": profile["sourcePage"],
                "sourceProfile": profile["label"],
                "url": desc_url,
                "label": trim(item.get("publicDescName")) or "产品说明书",
                "materialType": "product_manual",
                "sourceKind": "pdf",
                "recordNo": record_no,
            }
        )
    return tasks


def china_united_life_archive_pdf_is_terms(filename: str) -> bool:
    value = trim(filename)
    basename = re.split(r"[/\\]+", value)[-1]
    if not basename.lower().endswith(".pdf"):
        return False
    if any(keyword in basename for keyword in ("材料清单", "报送材料", "费率", "现金价值", "声明书", "批单")):
        return False
    return "条款" in basename


def china_united_life_record_from_pdf(
    task: dict[str, str], material_url: str, data: bytes, source_type: str, entry_name: str = ""
) -> dict[str, Any] | None:
    if len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or ("保险条款" if trim(task.get("materialType")) == "terms" else "产品说明书")
    return {
        "company": trim(task.get("company")) or "中华人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"中华人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": source_type,
        "materialType": trim(task.get("materialType")) or "terms",
        "official": True,
        "officialDomain": china_united_life_official_domain(material_url),
        "parser": "scrapling_china_united_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "archiveEntry": entry_name,
        "recordNo": trim(task.get("recordNo")),
        "sourceProfile": trim(task.get("sourceProfile")),
    }


def china_united_life_records_from_archive(task: dict[str, str], data: bytes) -> list[dict[str, Any]]:
    if not data or len(data) > MAX_ZIP_BYTES:
        return []
    archive_url = trim(task.get("url"))
    records: list[dict[str, Any]] = []
    suffix = ".zip" if archive_url.lower().endswith(".zip") else ".rar"
    with tempfile.TemporaryDirectory(prefix="china-united-life-archive-") as temp_dir:
        archive_path = os.path.join(temp_dir, f"archive{suffix}")
        extract_dir = os.path.join(temp_dir, "extract")
        os.makedirs(extract_dir, exist_ok=True)
        with open(archive_path, "wb") as output:
            output.write(data)
        proc = subprocess.run(
            ["bsdtar", "-xf", archive_path, "-C", extract_dir],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=90,
        )
        if proc.returncode != 0:
            return []
        for root, _, files in os.walk(extract_dir):
            for filename in files:
                full_path = os.path.join(root, filename)
                relative_name = os.path.relpath(full_path, extract_dir)
                if not china_united_life_archive_pdf_is_terms(relative_name):
                    continue
                try:
                    with open(full_path, "rb") as handle:
                        pdf_bytes = handle.read(MAX_PDF_BYTES + 1)
                except Exception:
                    continue
                material_url = f"{archive_url}#entry={quote(relative_name, safe='')}"
                record = china_united_life_record_from_pdf(task, material_url, pdf_bytes, "rar_pdf", relative_name)
                if record:
                    records.append(record)
    return records


def crawl_china_united_life_material_record(task: dict[str, str]) -> list[dict[str, Any]]:
    material_url = trim(task.get("url"))
    if not material_url or not china_united_life_is_official_url(material_url):
        return []
    if trim(task.get("sourceKind")) == "archive":
        status, _, data = fetch_binary_direct(
            material_url,
            referer=trim(task.get("sourcePage")) or CHINA_UNITED_LIFE_OFFICIAL_BASE_URL,
            max_bytes=MAX_ZIP_BYTES,
        )
        if status < 200 or status >= 300:
            return []
        return china_united_life_records_from_archive(task, data)
    status, _, data = fetch_binary_direct(
        material_url,
        referer=trim(task.get("sourcePage")) or CHINA_UNITED_LIFE_OFFICIAL_BASE_URL,
        max_bytes=MAX_PDF_BYTES,
    )
    if status < 200 or status >= 300:
        return []
    record = china_united_life_record_from_pdf(task, material_url, data, "pdf")
    return [record] if record else []


def crawl_china_united_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_china_united_life_material_record(task))
        return records
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_china_united_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return records


def crawl_china_united_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中华人寿"
    source = trim(payload.get("source")) or "all"
    page_size = max(1, int(payload.get("pageSize") or 20))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    profiles = china_united_life_source_profiles(source, trim(payload.get("saleStatus") or payload.get("status")))
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    seen_task_keys: set[str] = set()
    stop = False
    for profile in profiles:
        page_number = 1
        total_pages = 1
        while page_number <= total_pages and not stop:
            status, data = fetch_china_united_life_product_page(profile, page_size, page_number)
            rows = data.get("data") if isinstance(data.get("data"), list) else []
            total_count = int(data.get("totalCount") or len(rows) or 0)
            total_pages = max(1, (total_count + page_size - 1) // page_size)
            page_meta = {
                "url": f"{CHINA_UNITED_LIFE_PRODUCT_INFO_ENDPOINT}/{page_size}/{page_number}/{profile['prop']}/{profile['status']}",
                "sourcePage": profile["sourcePage"],
                "status": status,
                "sourceProfile": profile["label"],
                "salesStatus": profile["salesStatus"],
                "pageNumber": page_number,
                "totalPages": total_pages,
                "totalCount": total_count,
                "productCount": 0,
                "materialTaskCount": 0,
            }
            for item in rows:
                product = china_united_life_product_from_item(company, profile, item)
                if not product:
                    continue
                if max_products and len(products) >= max_products:
                    stop = True
                    break
                products.append(product)
                page_meta["productCount"] += 1
                for task in china_united_life_material_tasks_from_item(company, profile, item):
                    if trim(task.get("materialType")) == "terms":
                        key = f"terms|{trim(task.get('productName'))}|{trim(task.get('recordNo')) or trim(task.get('url'))}"
                    else:
                        key = f"{trim(task.get('materialType'))}|{trim(task.get('url'))}"
                    if key in seen_task_keys:
                        continue
                    seen_task_keys.add(key)
                    tasks.append(task)
                    page_meta["materialTaskCount"] += 1
            pages.append(page_meta)
            page_number += 1
    records = crawl_china_united_life_material_records(tasks, max_workers=max_workers)
    failed_pages = [page for page in pages if int(page.get("status") or 0) < 200 or int(page.get("status") or 0) >= 300]
    return {
        "ok": not failed_pages,
        "code": "" if not failed_pages else "CHINA_UNITED_LIFE_PAGE_FAILED",
        "message": "" if not failed_pages else "中华人寿官网产品信息接口有页面抓取失败。",
        "company": company,
        "source": CHINA_UNITED_LIFE_OFFICIAL_BASE_URL,
        "endpoint": CHINA_UNITED_LIFE_PRODUCT_INFO_ENDPOINT,
        "sourceMode": source,
        "pageSize": page_size,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def lian_life_official_domain(material_url: str) -> str:
    hostname = (urlsplit(material_url).hostname or "").lower()
    for domain in LIAN_LIFE_OFFICIAL_DOMAINS:
        if hostname == domain or hostname.endswith(f".{domain}"):
            return hostname
    return ""


def lian_life_is_official_url(material_url: str) -> bool:
    return bool(lian_life_official_domain(material_url))


def lian_life_sale_status_codes(sale_status: str) -> list[str]:
    value = trim(sale_status).lower()
    if value in {"sale", "selling", "insale", "in_sale", "on_sale", "2", "在售"}:
        return ["2"]
    if value in {"stop", "stopped", "off_sale", "3", "停售"}:
        return ["3"]
    return ["2", "3"]


def fetch_lian_life_product_page(status_code: str, page_size: int, page_number: int) -> tuple[int, dict[str, Any]]:
    payload = {
        "pageNum": page_number,
        "pageSize": page_size,
        "queryBean": {
            "productName": None,
            "productTypeCode": LIAN_LIFE_PRODUCT_TYPE_CODES,
            "status": status_code,
        },
    }
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "-X",
            "POST",
            "--max-time",
            "35",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            "Content-Type: application/json; charset=utf-8",
            "-H",
            f"Referer: {LIAN_LIFE_PRODUCT_BOX_URL}",
            "--data",
            json.dumps(payload, ensure_ascii=False),
            LIAN_LIFE_PRODUCT_LIST_ENDPOINT,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=45,
    )
    status = 200 if proc.returncode == 0 else 0
    try:
        return status, json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return status, {}


def lian_life_product_from_item(company: str, status_code: str, item: dict[str, Any]) -> dict[str, str] | None:
    product_name = trim(item.get("productName"))
    if not product_name:
        return None
    item_status = trim(item.get("status")) or status_code
    return {
        "company": company,
        "productName": product_name,
        "productType": trim(item.get("productType")),
        "salesStatus": LIAN_LIFE_SALE_STATUS_MAP.get(item_status, LIAN_LIFE_SALE_STATUS_MAP.get(status_code, "")),
        "productCode": trim(item.get("productCode")),
        "sourcePage": LIAN_LIFE_PRODUCT_BOX_URL,
    }


def lian_life_material_tasks_from_item(company: str, status_code: str, item: dict[str, Any]) -> list[dict[str, str]]:
    product = lian_life_product_from_item(company, status_code, item)
    if not product:
        return []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for file_item in item.get("productFileList") or []:
        file_type = trim(file_item.get("fileType"))
        material = LIAN_LIFE_MATERIAL_TYPES.get(file_type)
        if not material:
            continue
        material_url = trim(file_item.get("url"))
        if not material_url and trim(file_item.get("urlKey")):
            material_url = f"{LIAN_LIFE_OFFICIAL_BASE_URL}api/v1/boclian/pc/component/oss/download?{urlencode({'ossKey': trim(file_item.get('urlKey'))})}"
        if not material_url:
            continue
        material_url = urljoin(LIAN_LIFE_OFFICIAL_BASE_URL, material_url)
        if not lian_life_is_official_url(material_url) or material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        tasks.append(
            {
                **product,
                "label": material["label"],
                "materialType": material["materialType"],
                "fileType": file_type,
                "url": material_url,
                "fileName": trim(file_item.get("fileName")),
                "sourcePage": LIAN_LIFE_PRODUCT_BOX_URL,
            }
        )
    return tasks


def crawl_lian_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not lian_life_is_official_url(material_url):
        return None
    pdf_status, content_type, data = fetch_binary_direct(
        material_url,
        referer=trim(task.get("sourcePage")) or LIAN_LIFE_PRODUCT_BOX_URL,
    )
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "利安人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"利安人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": lian_life_official_domain(material_url),
        "parser": "scrapling_lian_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
    }


def crawl_lian_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_lian_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_lian_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_lian_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "利安人寿"
    status_codes = lian_life_sale_status_codes(trim(payload.get("saleStatus") or payload.get("status")))
    page_size = max(1, int(payload.get("pageSize") or 100))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    seen_tasks: set[str] = set()
    failed_pages: list[dict[str, Any]] = []

    for status_code in status_codes:
        page_number = 1
        total_pages = 1
        stop_status = False
        while page_number <= total_pages and not stop_status:
            http_status, data = fetch_lian_life_product_page(status_code, page_size, page_number)
            page_data = data.get("data") if isinstance(data.get("data"), dict) else {}
            items = page_data.get("list") if isinstance(page_data.get("list"), list) else []
            total_pages = int(page_data.get("pages") or 1)
            page_meta = {
                "url": LIAN_LIFE_PRODUCT_LIST_ENDPOINT,
                "sourcePage": LIAN_LIFE_PRODUCT_BOX_URL,
                "status": http_status,
                "apiStatus": data.get("status"),
                "salesStatus": LIAN_LIFE_SALE_STATUS_MAP.get(status_code, status_code),
                "statusCode": status_code,
                "pageNumber": page_number,
                "pageSize": page_size,
                "totalPages": total_pages,
                "totalCount": int(page_data.get("total") or 0),
                "productCount": 0,
                "materialTaskCount": 0,
            }
            if http_status < 200 or http_status >= 300 or data.get("status") != 200:
                failed_pages.append(page_meta)
                pages.append(page_meta)
                break
            for item in items:
                product = lian_life_product_from_item(company, status_code, item)
                if not product:
                    continue
                product_key = f"{status_code}|{product.get('productCode')}|{product.get('productName')}"
                if product_key not in seen_products:
                    if max_products and len(seen_products) >= max_products:
                        stop_status = True
                        break
                    seen_products.add(product_key)
                    products.append(product)
                    page_meta["productCount"] += 1
                for task in lian_life_material_tasks_from_item(company, status_code, item):
                    task_key = f"{product_key}|{task.get('materialType')}|{task.get('url')}"
                    if task_key in seen_tasks:
                        continue
                    seen_tasks.add(task_key)
                    tasks.append(task)
                    page_meta["materialTaskCount"] += 1
            pages.append(page_meta)
            page_number += 1

    records = crawl_lian_life_material_records(tasks, max_workers=max_workers)
    return {
        "ok": not failed_pages,
        "code": "" if not failed_pages else "LIAN_LIFE_PAGE_FAILED",
        "company": company,
        "source": LIAN_LIFE_OFFICIAL_BASE_URL,
        "endpoint": LIAN_LIFE_PRODUCT_LIST_ENDPOINT,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pageSize": page_size,
        "pages": pages,
        "failedPages": failed_pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def bocomm_life_source_filter(value: str) -> set[str]:
    selected = {item.strip().lower() for item in re.split(r"[,，\s]+", trim(value)) if item.strip()}
    if not selected or "all" in selected:
        return {"in_sale", "stopped_after_2024", "product_basic_info", "stopped_before_2024", "legacy_stopped", "telesales"}
    aliases = {
        "sale": "in_sale",
        "in-sale": "in_sale",
        "available": "in_sale",
        "在售": "in_sale",
        "stop": "stopped_after_2024",
        "stopped": "stopped_after_2024",
        "停售": "stopped_after_2024",
        "basic": "product_basic_info",
        "product-basic": "product_basic_info",
        "product_basic": "product_basic_info",
        "产品基本信息": "product_basic_info",
        "before2024": "stopped_before_2024",
        "before-2024": "stopped_before_2024",
        "pre2024": "stopped_before_2024",
        "pre-2024": "stopped_before_2024",
        "2024前": "stopped_before_2024",
        "2024年之前": "stopped_before_2024",
        "legacy": "legacy_stopped",
        "history": "legacy_stopped",
        "historical": "legacy_stopped",
        "历史": "legacy_stopped",
        "电销": "telesales",
        "phone": "telesales",
        "telesales": "telesales",
    }
    return {aliases.get(item, item) for item in selected}


def bocomm_life_page_url(base_url: str, page_index: int) -> str:
    return urljoin(base_url, "index.html" if page_index == 0 else f"index{page_index}.html")


def bocomm_life_official_url(url: str) -> bool:
    hostname = trim(urlsplit(url).hostname).lower()
    return hostname == "bocommlife.com" or hostname.endswith(".bocommlife.com")


def bocomm_life_material_type(label: str, url: str = "") -> str:
    text = f"{label} {url}"
    if BOCOMM_LIFE_EXCLUDED_MATERIAL_RE.search(text):
        return ""
    if "说明书" in text or "产品说明" in text or text.strip() == "产品说明":
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def bocomm_life_product_type(product_name: str, fallback: str = "") -> str:
    return taikang_life_product_type(product_name) or trim(fallback)


def bocomm_life_clean_product_name(value: str) -> str:
    text = clean_text(value)
    text = re.sub(r"^主险[:：]\s*", "", text)
    text = re.sub(r"^附加险[:：]\s*", "", text)
    text = re.sub(r"\s*（产品停售时间[:：][^)）]+[)）]\s*$", "", text)
    return clean_text(text)


def bocomm_life_focused_responsibility_excerpt(text: str) -> str:
    normalized = clean_text(text)
    if not normalized:
        return ""
    starts: list[int] = []
    strict_patterns = [
        r"【\s*保险责任\s*】",
        r"(?:\d+(?:[．.]\d+)+|第[一二三四五六七八九十百]+条)\s*保险责任\s*(?=在本|在保险|本公司|我们|被保险人)",
        r"保险责任\s*(?=在本(?:主)?合同保险期间内|在保险期间内|本公司承担|我们承担)",
    ]
    for strict_pattern in strict_patterns:
        for match in re.finditer(strict_pattern, normalized):
            starts.append(match.start())
    if starts:
        start = starts[0]
    else:
        pattern = re.compile(r"(?:第[一二三四五六七八九十百]+条\s*)?(?:\d+(?:[．.]\d+)+\s*)?保险责任")
        body_markers = [normalized.find(marker) for marker in ["在本条款中", "您与本公司订立的合同", "1.1 合同构成"]]
        body_start = min([index for index in body_markers if index >= 0], default=0)
        later_matches = [match.start() for match in pattern.finditer(normalized) if match.start() > body_start + 300]
        start = later_matches[0] if later_matches else normalized.find("保险责任")
    if start < 0:
        return ""
    tail = normalized[start:]
    end_match = re.search(
        r"(?:第[一二三四五六七八九十百]+条\s*)?(?:\d+(?:[．.]\d+)+\s*)?(?:责任免除|保险责任的免除|其他免责条款|保险金的申请|保险金申请|保单红利|释义)",
        tail[100:],
    )
    excerpt = tail[: 100 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
    return excerpt[:MAX_EXCERPT_CHARS].strip()


def bocomm_life_parse_total_pages(html: str) -> int:
    match = re.search(r"共\s*<span>\s*(\d+)\s*</span>\s*页", html)
    if not match:
        return 1
    return max(1, int(match.group(1)))


def bocomm_life_products_from_list_page(
    company: str,
    page_info: dict[str, str],
    page_url: str,
    html: str,
) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    for anchor in soup.select(".xwzx-right ul a"):
        detail_url = urljoin(page_url, trim(anchor.get("href")))
        if "detail" not in detail_url or not bocomm_life_official_url(detail_url):
            continue
        text = clean_text(anchor.get_text(" ", strip=True))
        date_match = re.search(r"(\d{4}-\d{2}-\d{2})$", text)
        disclosed_at = date_match.group(1) if date_match else ""
        if disclosed_at:
            text = clean_text(text[: -len(disclosed_at)])
        product_name = bocomm_life_clean_product_name(text)
        if not product_name:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": bocomm_life_product_type(product_name),
                "salesStatus": page_info["salesStatus"],
                "sourcePage": page_url,
                "detailUrl": detail_url,
                "pageKey": page_info["key"],
                "disclosedAt": disclosed_at,
            }
        )
    return products


def bocomm_life_collect_listing_products(
    company: str,
    page_info: dict[str, str],
    max_pages: int,
) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    products: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    seen_detail_urls: set[str] = set()
    page_index = 0
    empty_or_missing = 0
    discovered_page_limit = 0
    while True:
        if max_pages and page_index >= max_pages:
            break
        page_url = bocomm_life_page_url(page_info["baseUrl"], page_index)
        status, html = fetch_html(page_url)
        page_products: list[dict[str, str]] = []
        if 200 <= status < 300 and html:
            if page_index == 0:
                discovered_page_limit = bocomm_life_parse_total_pages(html)
            page_products = bocomm_life_products_from_list_page(company, page_info, page_url, html)
        page_meta = {
            "key": page_info["key"],
            "url": page_url,
            "status": status,
            "salesStatus": page_info["salesStatus"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        for product in page_products:
            detail_url = trim(product.get("detailUrl"))
            if not detail_url or detail_url in seen_detail_urls:
                continue
            seen_detail_urls.add(detail_url)
            products.append(product)
            page_meta["productCount"] += 1
        pages.append(page_meta)
        if status < 200 or status >= 300 or not page_products:
            empty_or_missing += 1
        else:
            empty_or_missing = 0
        page_index += 1
        if discovered_page_limit > 1 and page_index >= discovered_page_limit:
            break
        if discovered_page_limit <= 1 and empty_or_missing >= 1 and page_index > 0:
            break
        if page_index > 25:
            break
    return products, pages


def bocomm_life_detail_tasks(product: dict[str, str]) -> dict[str, Any]:
    detail_url = trim(product.get("detailUrl"))
    status, html = fetch_html(detail_url)
    tasks: list[dict[str, str]] = []
    if status < 200 or status >= 300 or not html:
        return {"url": detail_url, "status": status, "tasks": tasks}
    soup = BeautifulSoup(html, "html.parser")
    current_label = ""
    for row in soup.find_all("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all(["td", "th"])]
        if not cells or any("产品材料" in cell for cell in cells):
            continue
        first = cells[0]
        if first and "点击查看" not in first and not re.fullmatch(r"\d{4}年\d{1,2}月\d{1,2}日|-", first):
            current_label = first
        label = current_label
        material_type_value = bocomm_life_material_type(label)
        if not material_type_value:
            continue
        for anchor in row.find_all("a"):
            material_url = urljoin(detail_url, trim(anchor.get("href")))
            if not bocomm_life_official_url(material_url) or not material_url.lower().endswith(".pdf"):
                continue
            tasks.append(
                {
                    "company": trim(product.get("company")) or "交银人寿",
                    "productName": trim(product.get("productName")),
                    "productType": trim(product.get("productType")),
                    "salesStatus": trim(product.get("salesStatus")),
                    "label": label,
                    "materialType": material_type_value,
                    "title": f"{trim(product.get('productName'))}{label}",
                    "url": material_url,
                    "sourcePage": trim(product.get("sourcePage")),
                    "detailUrl": detail_url,
                    "pageKey": trim(product.get("pageKey")),
                    "enabledAt": next((cell for cell in cells if re.fullmatch(r"\d{4}年\d{1,2}月\d{1,2}日", cell)), ""),
                }
            )
    return {"url": detail_url, "status": status, "tasks": tasks}


def bocomm_life_detail_task_results(products: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not products:
        return []
    if max_workers <= 1:
        return [bocomm_life_detail_tasks(product) for product in products]
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(bocomm_life_detail_tasks, product) for product in products]
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as error:
                results.append({"url": "", "status": 0, "error": str(error), "tasks": []})
    return results


def bocomm_life_legacy_stopped_products_and_tasks(company: str) -> tuple[list[dict[str, str]], list[dict[str, str]], dict[str, Any]]:
    status, html = fetch_html(BOCOMM_LIFE_LEGACY_STOPPED_URL)
    page = {
        "key": "legacy_stopped",
        "url": BOCOMM_LIFE_LEGACY_STOPPED_URL,
        "status": status,
        "salesStatus": "停售（历史）",
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return [], [], page
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    current_product: dict[str, str] | None = None
    seen_products: set[str] = set()
    for row in soup.find_all("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all(["td", "th"])]
        if not cells or "产品名称" in " ".join(cells[:2]):
            continue
        if len(cells) >= 3 and re.fullmatch(r"\d+", cells[0] or ""):
            product_name = bocomm_life_clean_product_name(cells[1])
            if product_name:
                current_product = {
                    "company": company,
                    "productName": product_name,
                    "productType": bocomm_life_product_type(product_name),
                    "salesStatus": "停售（历史）",
                    "sourcePage": BOCOMM_LIFE_LEGACY_STOPPED_URL,
                    "detailUrl": "",
                    "pageKey": "legacy_stopped",
                }
                if product_name not in seen_products:
                    seen_products.add(product_name)
                    products.append(current_product)
        if not current_product:
            continue
        row_text = " ".join(cells)
        material_type_value = bocomm_life_material_type(row_text)
        if not material_type_value:
            continue
        for anchor in row.find_all("a"):
            material_url = urljoin(BOCOMM_LIFE_LEGACY_STOPPED_URL, trim(anchor.get("href")))
            if not bocomm_life_official_url(material_url) or not material_url.lower().endswith(".pdf"):
                continue
            label = clean_text(anchor.get_text(" ", strip=True)) or row_text
            tasks.append(
                {
                    "company": company,
                    "productName": current_product["productName"],
                    "productType": current_product["productType"],
                    "salesStatus": current_product["salesStatus"],
                    "label": label,
                    "materialType": material_type_value,
                    "title": f"{current_product['productName']}{label}",
                    "url": material_url,
                    "sourcePage": BOCOMM_LIFE_LEGACY_STOPPED_URL,
                    "detailUrl": "",
                    "pageKey": "legacy_stopped",
                }
            )
    page["productCount"] = len(products)
    page["materialTaskCount"] = len(tasks)
    return products, tasks, page


def bocomm_life_telesales_products_and_tasks(company: str) -> tuple[list[dict[str, str]], list[dict[str, str]], dict[str, Any]]:
    status, html = fetch_html(BOCOMM_LIFE_TELESALES_URL)
    page = {
        "key": "telesales",
        "url": BOCOMM_LIFE_TELESALES_URL,
        "status": status,
        "salesStatus": "电销目录",
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return [], [], page
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    current_product_name = ""
    current_status = "电销目录"
    for row in soup.find_all("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all(["td", "th"])]
        if not cells or "产品名称" in " ".join(cells):
            continue
        candidate = ""
        if len(cells) >= 3 and re.fullmatch(r"\d+", cells[0] or ""):
            candidate = cells[2]
            current_status = "电销停售" if "停售" in " ".join(cells[:3]) else "电销目录"
        elif cells:
            candidate = cells[0]
        product_name = bocomm_life_clean_product_name(candidate)
        if product_name:
            current_product_name = product_name
            if product_name not in seen_products:
                seen_products.add(product_name)
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": bocomm_life_product_type(product_name),
                        "salesStatus": current_status,
                        "sourcePage": BOCOMM_LIFE_TELESALES_URL,
                        "detailUrl": "",
                        "pageKey": "telesales",
                    }
                )
        if not current_product_name:
            continue
        for anchor in row.find_all("a"):
            label = clean_text(anchor.get_text(" ", strip=True))
            material_type_value = bocomm_life_material_type(label)
            material_url = urljoin(BOCOMM_LIFE_TELESALES_URL, trim(anchor.get("href")))
            if not material_type_value or not bocomm_life_official_url(material_url) or not material_url.lower().endswith(".pdf"):
                continue
            tasks.append(
                {
                    "company": company,
                    "productName": current_product_name,
                    "productType": bocomm_life_product_type(current_product_name),
                    "salesStatus": current_status,
                    "label": label,
                    "materialType": material_type_value,
                    "title": f"{current_product_name}{label}",
                    "url": material_url,
                    "sourcePage": BOCOMM_LIFE_TELESALES_URL,
                    "detailUrl": "",
                    "pageKey": "telesales",
                }
            )
    page["productCount"] = len(products)
    page["materialTaskCount"] = len(tasks)
    return products, tasks, page


def bocomm_life_direct_table_products_and_tasks(
    company: str, page_info: dict[str, str], max_products: int = 0, product_offset: int = 0
) -> tuple[list[dict[str, str]], list[dict[str, str]], dict[str, Any]]:
    page_url = page_info["url"]
    status, html = fetch_html(page_url)
    page = {
        "key": page_info["key"],
        "url": page_url,
        "status": status,
        "salesStatus": page_info["salesStatus"],
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return [], [], page
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    current_product: dict[str, str] | None = None
    seen_products: set[str] = set()
    product_index = 0
    for row in soup.find_all("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all(["td", "th"])]
        if not cells or "产品名称" in " ".join(cells[:3]):
            continue
        if len(cells) >= 2 and re.fullmatch(r"\d+", cells[0] or ""):
            product_index += 1
            current_product = None
            if product_index <= product_offset:
                continue
            if max_products and len(products) >= max_products:
                break
            product_name = bocomm_life_clean_product_name(cells[1])
            if product_name:
                current_product = {
                    "company": company,
                    "productName": product_name,
                    "productType": bocomm_life_product_type(product_name),
                    "salesStatus": page_info["salesStatus"],
                    "sourcePage": page_url,
                    "detailUrl": "",
                    "pageKey": page_info["key"],
                }
                if product_name not in seen_products:
                    seen_products.add(product_name)
                    products.append(current_product)
        if not current_product:
            continue
        row_text = " ".join(cells)
        for anchor in row.find_all("a"):
            label = clean_text(anchor.get_text(" ", strip=True)) or row_text
            material_url = urljoin(page_url, trim(anchor.get("href")))
            if not bocomm_life_official_url(material_url):
                continue
            lower_url = material_url.lower().split("#", 1)[0].split("?", 1)[0]
            if not lower_url.endswith((".pdf", ".rar", ".zip")):
                continue
            material_type_value = bocomm_life_material_type(label, material_url) or bocomm_life_material_type(row_text, material_url)
            if not material_type_value:
                continue
            tasks.append(
                {
                    "company": company,
                    "productName": current_product["productName"],
                    "productType": current_product["productType"],
                    "salesStatus": current_product["salesStatus"],
                    "label": label,
                    "materialType": material_type_value,
                    "title": f"{current_product['productName']}{label}",
                    "url": material_url,
                    "sourcePage": page_url,
                    "detailUrl": "",
                    "pageKey": page_info["key"],
                    "sourceKind": "archive" if lower_url.endswith((".rar", ".zip")) else "pdf",
                }
            )
    page["productCount"] = len(products)
    page["materialTaskCount"] = len(tasks)
    return products, tasks, page


def bocomm_life_archive_suffix(url: str, data: bytes) -> str:
    path = urlsplit(url).path.lower()
    if path.endswith(".zip") or data.startswith(b"PK"):
        return ".zip"
    if path.endswith(".rar") or data.startswith(b"Rar!"):
        return ".rar"
    return ".archive"


def bocomm_life_archive_material_from_filename(filename: str, fallback_type: str = "") -> dict[str, str] | None:
    value = trim(filename)
    basename = re.split(r"[/\\]+", value)[-1]
    lower = basename.lower()
    if not lower.endswith(".pdf"):
        return None
    excluded = r"费率|保险费率|现金价值|现价|领取转换表|转换表|利益演示|账户价值|基本保险金额|投保规则|投保须知|告知书|职业分类|材料清单|清单|报送材料|备案报送|编码信息表|声明书|批单|批复|变更原因|对比说明|法律责任人"
    if re.search(excluded, basename, re.I):
        return None
    if "产品说明书" in basename or "产品说明" in basename:
        return {"label": "产品说明书", "materialType": "product_manual", "title": re.sub(r"\.pdf$", "", basename, flags=re.I)}
    if "保险条款" in basename or "利益条款" in basename or "条款" in basename:
        return {"label": "保险条款", "materialType": "terms", "title": re.sub(r"\.pdf$", "", basename, flags=re.I)}
    if fallback_type in {"terms", "product_manual"} and not BOCOMM_LIFE_EXCLUDED_MATERIAL_RE.search(basename):
        label = "产品说明书" if fallback_type == "product_manual" else "保险条款"
        return {"label": label, "materialType": fallback_type, "title": re.sub(r"\.pdf$", "", basename, flags=re.I)}
    return None


def bocomm_life_record_from_pdf(
    task: dict[str, str],
    material_url: str,
    data: bytes,
    source_type: str = "pdf",
    entry_name: str = "",
    archive_material: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = bocomm_life_focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim((archive_material or {}).get("label")) or trim(task.get("label"))
    material_type_value = trim((archive_material or {}).get("materialType")) or trim(task.get("materialType")) or bocomm_life_material_type(label)
    title = trim((archive_material or {}).get("title")) or trim(task.get("title")) or f"{product_name}{label}"
    return {
        "company": trim(task.get("company")) or "交银人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": title,
        "url": material_url,
        "snippet": f"交银人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": source_type,
        "materialType": material_type_value,
        "official": True,
        "officialDomain": BOCOMM_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_bocomm_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "archiveEntry": entry_name,
    }


def bocomm_life_records_from_archive(task: dict[str, str], data: bytes) -> list[dict[str, Any]]:
    if not data or len(data) > MAX_ZIP_BYTES:
        return []
    archive_url = trim(task.get("url"))
    suffix = bocomm_life_archive_suffix(archive_url, data)
    if suffix not in {".zip", ".rar"}:
        return []
    records: list[dict[str, Any]] = []
    bsdtar = os.environ.get("BSDTAR_BIN") or "/usr/bin/bsdtar"
    with tempfile.TemporaryDirectory(prefix="bocomm-life-archive-") as temp_dir:
        archive_path = os.path.join(temp_dir, f"material{suffix}")
        extract_dir = os.path.join(temp_dir, "extract")
        os.makedirs(extract_dir, exist_ok=True)
        with open(archive_path, "wb") as handle:
            handle.write(data)
        try:
            proc = subprocess.run(
                [bsdtar, "-xf", archive_path, "-C", extract_dir],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=60,
            )
        except Exception:
            return []
        if proc.returncode != 0:
            return []
        extract_root = os.path.abspath(extract_dir)
        for root, _, files in os.walk(extract_dir):
            for filename in files:
                file_path = os.path.abspath(os.path.join(root, filename))
                if not file_path.startswith(extract_root + os.sep):
                    continue
                relative_name = os.path.relpath(file_path, extract_dir)
                material = bocomm_life_archive_material_from_filename(relative_name, trim(task.get("materialType")))
                if not material:
                    continue
                try:
                    size = os.path.getsize(file_path)
                except Exception:
                    continue
                if size <= 0 or size > MAX_PDF_BYTES:
                    continue
                try:
                    with open(file_path, "rb") as pdf_file:
                        pdf_bytes = pdf_file.read(MAX_PDF_BYTES + 1)
                except Exception:
                    continue
                material_url = f"{archive_url}#entry={quote(relative_name, safe='')}"
                record = bocomm_life_record_from_pdf(task, material_url, pdf_bytes, "archive_pdf", relative_name, material)
                if record:
                    records.append(record)
    return records


def crawl_bocomm_life_material_record(task: dict[str, str]) -> list[dict[str, Any]]:
    material_url = trim(task.get("url"))
    if not material_url or not bocomm_life_official_url(material_url):
        return []
    referer = trim(task.get("detailUrl")) or trim(task.get("sourcePage")) or BOCOMM_LIFE_OFFICIAL_BASE_URL
    if trim(task.get("sourceKind")) == "archive" or material_url.lower().split("#", 1)[0].split("?", 1)[0].endswith((".rar", ".zip")):
        status, _, data = fetch_binary_direct(material_url, referer=referer, max_bytes=MAX_ZIP_BYTES)
        if status < 200 or status >= 300:
            return []
        return bocomm_life_records_from_archive(task, data)
    pdf_status, data = fetch_bytes_direct(material_url, referer=referer)
    if pdf_status < 200 or pdf_status >= 300:
        return []
    record = bocomm_life_record_from_pdf(task, material_url, data, "pdf")
    return [record] if record else []


def crawl_bocomm_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_bocomm_life_material_record(task))
        return records
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_bocomm_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return records


def crawl_bocomm_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "交银人寿"
    source_filter = bocomm_life_source_filter(trim(payload.get("source") or payload.get("sourceScope")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    max_detail_workers = max(1, int(payload.get("maxDetailWorkers") or payload.get("detailConcurrency") or max_workers))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, str]] = []
    direct_tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()

    for page_info in BOCOMM_LIFE_LIST_PAGES:
        if page_info["key"] not in source_filter:
            continue
        page_products, page_metas = bocomm_life_collect_listing_products(company, page_info, max_pages)
        for product in page_products:
            key = trim(product.get("detailUrl")) or f"{product.get('salesStatus')}|{product.get('productName')}"
            if key in seen_products:
                continue
            if max_products and len(products) >= max_products:
                break
            seen_products.add(key)
            products.append(product)
        pages.extend(page_metas)

    for page_info in BOCOMM_LIFE_DIRECT_TABLE_PAGES:
        if page_info["key"] not in source_filter:
            continue
        remaining_products = max(0, max_products - len(products)) if max_products else 0
        if max_products and remaining_products <= 0:
            break
        table_products, table_tasks, table_page = bocomm_life_direct_table_products_and_tasks(
            company,
            page_info,
            remaining_products,
            product_offset,
        )
        products.extend(table_products)
        direct_tasks.extend(table_tasks)
        pages.append(table_page)

    if "legacy_stopped" in source_filter and not max_products:
        legacy_products, legacy_tasks, legacy_page = bocomm_life_legacy_stopped_products_and_tasks(company)
        products.extend(legacy_products)
        direct_tasks.extend(legacy_tasks)
        pages.append(legacy_page)

    if "telesales" in source_filter and not max_products:
        telesales_products, telesales_tasks, telesales_page = bocomm_life_telesales_products_and_tasks(company)
        products.extend(telesales_products)
        direct_tasks.extend(telesales_tasks)
        pages.append(telesales_page)

    detail_results = bocomm_life_detail_task_results(
        [product for product in products if trim(product.get("detailUrl"))],
        max_workers=max_detail_workers,
    )
    tasks: list[dict[str, str]] = []
    for result in detail_results:
        tasks.extend(result.get("tasks") or [])
    tasks.extend(direct_tasks)

    seen_task_urls: set[str] = set()
    deduped_tasks: list[dict[str, str]] = []
    for task in tasks:
        material_url = trim(task.get("url"))
        if not material_url or material_url in seen_task_urls:
            continue
        seen_task_urls.add(material_url)
        deduped_tasks.append(task)

    records = crawl_bocomm_life_material_records(deduped_tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in deduped_tasks}
    record_counts_by_page: dict[str, int] = {}
    task_counts_by_page: dict[str, int] = {}
    for task in deduped_tasks:
        page_url = trim(task.get("sourcePage"))
        if page_url:
            task_counts_by_page[page_url] = task_counts_by_page.get(page_url, 0) + 1
    for record in records:
        record_url = trim(record.get("url"))
        page_url = task_page_by_url.get(record_url) or task_page_by_url.get(record_url.split("#", 1)[0])
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page_url = trim(page.get("url"))
        if page_url:
            page["materialTaskCount"] = page.get("materialTaskCount") or task_counts_by_page.get(page_url, 0)
            page["recordCount"] = record_counts_by_page.get(page_url, 0)

    return {
        "ok": True,
        "company": company,
        "source": BOCOMM_LIFE_OFFICIAL_BASE_URL,
        "sourceScope": sorted(source_filter),
        "maxProducts": max_products,
        "productOffset": product_offset,
        "maxPages": max_pages,
        "maxWorkers": max_workers,
        "maxDetailWorkers": max_detail_workers,
        "pages": pages,
        "products": products,
        "detailFetchCount": len(detail_results),
        "failedDetailCount": len([item for item in detail_results if int(item.get("status") or 0) < 200 or int(item.get("status") or 0) >= 300]),
        "materialTaskCount": len(deduped_tasks),
        "records": records,
    }


def xintai_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"sale", "stop"}
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return {"sale"}
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return {"stop"}
    return {"sale", "stop"}


def xintai_life_product_type(product_name: str, raw_type: str = "") -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "医疗" in product_name or "护理" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return trim(raw_type)


def fetch_xintai_life_products(keyword: str = "") -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "--max-time",
            "45",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {XINTAI_LIFE_PRODUCT_INFO_URL}",
            "-H",
            "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
            "--data-urlencode",
            f"key={keyword}",
            XINTAI_LIFE_PRODUCT_LIST_ENDPOINT,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
    )
    if proc.returncode != 0:
        return 0, {}
    try:
        return 200, json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return 200, {}


def xintai_life_product_rows(company: str, data: dict[str, Any], status_filter: set[str], max_products: int) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    sources = [
        ("sale", "在售", data.get("saleProductDTO") if isinstance(data.get("saleProductDTO"), list) else []),
        ("stop", "停售", data.get("stopProductDTO") if isinstance(data.get("stopProductDTO"), list) else []),
    ]
    for status_key, base_status, items in sources:
        if status_key not in status_filter:
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            product_name = trim(item.get("productName"))
            if not product_name:
                continue
            stop_time = trim(item.get("stopTime"))
            sales_status = f"{base_status}（{stop_time}）" if status_key == "stop" and stop_time else base_status
            product_key = f"{status_key}|{product_name}|{trim(item.get('productCode'))}"
            if product_key in seen_products:
                continue
            if max_products and len(products) >= max_products:
                return products
            seen_products.add(product_key)
            material_url = urljoin(XINTAI_LIFE_OFFICIAL_BASE_URL, trim(item.get("url")))
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": xintai_life_product_type(product_name, trim(item.get("productType"))),
                    "salesStatus": sales_status,
                    "sourcePage": XINTAI_LIFE_PRODUCT_INFO_URL,
                    "productCode": trim(item.get("productCode")),
                    "productTypeLevel": trim(item.get("productTypeLevel")),
                    "rawProductType": trim(item.get("productType")),
                    "materialUrl": material_url if ".pdf" in material_url.lower() else "",
                }
            )
    return products


def xintai_life_internet_product_rows(company: str, html: str, status_filter: set[str], max_products: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    tabs = [trim(item.get_text(" ", strip=True)) for item in soup.select(".title ul li")]
    products: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, message in enumerate(soup.select("div.message")):
        tab_label = tabs[index] if index < len(tabs) else ""
        status_key = "stop" if "停售" in tab_label else "sale"
        if status_key not in status_filter:
            continue
        sales_status = "停售" if status_key == "stop" else "在售"
        for row in message.select("tr")[1:]:
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            product_name = trim(cells[1].get_text(" ", strip=True))
            if not product_name:
                continue
            for anchor in cells[2].find_all("a"):
                href = trim(anchor.get("href"))
                if ".pdf" not in href.lower():
                    continue
                material_url = urljoin(XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL, href)
                key = f"{sales_status}|{product_name}|{material_url}"
                if key in seen:
                    continue
                if max_products and len(products) >= max_products:
                    return products
                seen.add(key)
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": xintai_life_product_type(product_name),
                        "salesStatus": sales_status,
                        "sourcePage": XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL,
                        "productCode": "",
                        "productTypeLevel": "",
                        "rawProductType": "",
                        "materialUrl": material_url,
                    }
                )
    return products


def xintai_life_official_domain(material_url: str) -> str:
    hostname = urlsplit(material_url).hostname or ""
    if hostname.endswith("sinatay.com"):
        return "sinatay.com"
    return XINTAI_LIFE_OFFICIAL_DOMAIN


def crawl_xintai_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=XINTAI_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    return {
        "company": trim(task.get("company")) or "信泰人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}产品备案材料",
        "url": material_url,
        "snippet": "信泰人寿官网产品备案材料，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": "terms",
        "official": True,
        "officialDomain": xintai_life_official_domain(material_url),
        "parser": "scrapling_xintai_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_xintai_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_xintai_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_xintai_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_xintai_life_product_info(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "信泰人寿"
    keyword = trim(payload.get("keyword"))
    status_filter = xintai_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, data = fetch_xintai_life_products(keyword)
    page_meta = {
        "url": XINTAI_LIFE_PRODUCT_LIST_ENDPOINT,
        "sourcePage": XINTAI_LIFE_PRODUCT_INFO_URL,
        "status": status,
        "saleStatus": ",".join(sorted(status_filter)),
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not data:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}

    products = xintai_life_product_rows(company, data, status_filter, max_products)
    tasks: list[dict[str, str]] = []
    seen_tasks: set[str] = set()
    for product in products:
        material_url = trim(product.get("materialUrl"))
        if not material_url:
            continue
        task_key = f"{product['salesStatus']}|{product['productName']}|{material_url}"
        if task_key in seen_tasks:
            continue
        seen_tasks.add(task_key)
        tasks.append(
            {
                "company": company,
                "productName": product["productName"],
                "productType": product["productType"],
                "salesStatus": product["salesStatus"],
                "url": material_url,
            }
        )

    records = crawl_xintai_life_material_records(tasks, max_workers=max_workers)
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    page_meta["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": XINTAI_LIFE_PRODUCT_INFO_URL,
        "endpoint": XINTAI_LIFE_PRODUCT_LIST_ENDPOINT,
        "saleStatus": ",".join(sorted(status_filter)),
        "keyword": keyword,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [page_meta],
        "products": [{key: value for key, value in product.items() if key != "materialUrl"} for product in products],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def cathay_life_decode_zip_filename(filename: str) -> str:
    value = filename or ""
    try:
        decoded = value.encode("cp437").decode("gbk")
    except Exception:
        return value
    if any(keyword in decoded for keyword in ("陆家嘴国泰", "保险", "条款", "产品说明书", "费率表")):
        return decoded
    return value


def cathay_life_zip_entry_basename(filename: str) -> str:
    return re.split(r"[/\\]+", cathay_life_decode_zip_filename(filename))[-1]


def cathay_life_zip_entry_material(filename: str) -> dict[str, str] | None:
    value = trim(cathay_life_decode_zip_filename(filename))
    basename = cathay_life_zip_entry_basename(value)
    lower = value.lower()
    if not lower.endswith(".pdf"):
        return None
    if re.search(r"(?:^|[/\\])2-", value):
        return {"label": "保险条款", "materialType": "terms"}
    if re.search(r"(?:^|[/\\])(?:10\.5|12\.13)-", value):
        return {"label": "产品说明书", "materialType": "product_manual"}
    if "产品说明书" in value or "产品说明文档" in value:
        return {"label": "产品说明书", "materialType": "product_manual"}
    excluded_terms = ("材料清单", "清单", "费率", "报送材料")
    if ("保险条款" in value or ("条款" in basename and not basename.startswith("1-"))) and not any(
        keyword in value for keyword in excluded_terms
    ):
        return {"label": "保险条款", "materialType": "terms"}
    if "产品说明书" in basename:
        return {"label": "产品说明书", "materialType": "product_manual"}
    return None


def cathay_life_records_from_filing_zip(task: dict[str, str], data: bytes, content_type: str = "") -> list[dict[str, Any]]:
    if len(data) > MAX_ZIP_BYTES or not data.startswith(b"PK"):
        return []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return []
    records: list[dict[str, Any]] = []
    zip_url = trim(task.get("url"))
    product_name = trim(task.get("productName"))
    for index, info in enumerate(archive.infolist()):
        material = cathay_life_zip_entry_material(info.filename)
        if not material or info.file_size <= 0 or info.file_size > MAX_PDF_BYTES:
            continue
        try:
            pdf_bytes = archive.read(info)
        except Exception:
            continue
        if len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF"):
            continue
        extracted = extract_pdf_text_with_system_python(pdf_bytes)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        if not page_text:
            continue
        label = material["label"]
        basename = cathay_life_zip_entry_basename(info.filename)
        records.append(
            {
                "company": trim(task.get("company")) or "陆家嘴国泰人寿",
                "productName": product_name,
                "productType": trim(task.get("productType")),
                "salesStatus": trim(task.get("salesStatus")) or "备案信息",
                "title": f"{product_name}备案材料{label}",
                "url": f"{zip_url}#entry={index}-{quote(basename, safe='')}",
                "snippet": f"陆家嘴国泰官网备案ZIP内{label}，已截取保险责任正文段。",
                "pageText": page_text,
                "sourceType": "zip_pdf",
                "materialType": material["materialType"],
                "official": True,
                "officialDomain": "www.cathaylife.cn",
                "parser": "scrapling_cathay_life_filing_zip",
                "pages": extracted.get("pages", 0),
                "bytes": len(pdf_bytes),
                "contentType": content_type,
            }
        )
    return records


def crawl_cathay_life_filing_zip_records(task: dict[str, str]) -> list[dict[str, Any]]:
    zip_url = trim(task.get("url"))
    status, content_type, data = fetch_bytes_with_cathay_cookies(
        zip_url,
        referer=trim(task.get("sourcePage")) or CATHAY_LIFE_FILING_URL,
        cookie_header=trim(task.get("cookieHeader")),
        max_bytes=MAX_ZIP_BYTES,
    )
    if status < 200 or status >= 300:
        return []
    return cathay_life_records_from_filing_zip(task, data, content_type)


def crawl_cathay_life_filing_zip_records_batch(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_cathay_life_filing_zip_records(task))
        return records
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_cathay_life_filing_zip_records, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return records


async def crawl_cathay_life_filing_pages_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": []}
    company = trim(payload.get("company")) or "陆家嘴国泰人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    user_data_dir = trim(payload.get("userDataDir")) or "/tmp/chrome-cathaylife-crawl"
    headless_value = trim(payload.get("headless"))
    headless = headless_value.lower() not in {"0", "false", "no", "headed"}

    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_zip_urls: set[str] = set()
    records: list[dict[str, Any]] = []
    failed_downloads = 0

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch_persistent_context(
            user_data_dir,
            headless=headless,
            executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            args=["--no-first-run", "--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900},
        )
        try:
            page = await browser.new_page()
            response = await page.goto(CATHAY_LIFE_FILING_URL, wait_until="networkidle", timeout=60000)
            text = await page.locator("body").inner_text(timeout=10000)
            page_meta = {
                "url": CATHAY_LIFE_FILING_URL,
                "status": response.status if response else 0,
                "salesStatus": "备案信息",
                "productCount": 0,
                "materialTaskCount": 0,
                "recordCount": 0,
                "failedDownloadCount": 0,
            }
            if page_meta["status"] in {405, 412} or "确认您是真人" in text or "正在验证您是否是真人" in text or "需要先检查您的连接" in text:
                return {
                    "ok": False,
                    "code": "CATHAY_LIFE_HUMAN_VERIFICATION_REQUIRED",
                    "message": "陆家嘴国泰官网备案信息页返回人机校验，需要打开真实浏览器完成验证后重试。",
                    "company": company,
                    "pages": [{**page_meta, "ok": False}],
                    "products": [],
                    "records": [],
                }
            rows = await page.evaluate(
                """() => Array.from(document.querySelectorAll('table')).flatMap((table, tableIndex) => {
                  const tableHeader = Array.from(table.querySelectorAll('tr:first-child th, tr:first-child td')).map((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim()).join(' ');
                  return Array.from(table.querySelectorAll('tr')).slice(1).map((row) => {
                    const cells = Array.from(row.querySelectorAll('td'));
                    if (cells.length < 2) return null;
                    return {
                      tableIndex,
                      tableHeader,
                      productName: (cells[0].innerText || '').replace(/\s+/g, ' ').trim(),
                      productClass: (cells[2]?.innerText || '').replace(/\s+/g, ' ').trim(),
                      rawText: row.innerText || '',
                      materials: Array.from(cells[1].querySelectorAll('a')).map((anchor) => ({
                        label: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim(),
                        url: anchor.href || '',
                      })),
                    };
                  }).filter(Boolean);
                })"""
            )
            for row in rows if isinstance(rows, list) else []:
                product_name = trim(row.get("productName"))
                if not product_name:
                    continue
                product_key = f"备案信息|{product_name}"
                if max_products and len(seen_products) >= max_products and product_key not in seen_products:
                    continue
                product_type = cathay_life_product_type(product_name)
                if product_key not in seen_products:
                    seen_products.add(product_key)
                    products.append(
                        {
                            "company": company,
                            "productName": product_name,
                            "productType": product_type,
                            "salesStatus": "备案信息",
                            "sourcePage": CATHAY_LIFE_FILING_URL,
                        }
                    )
                for material in row.get("materials") or []:
                    zip_url = trim(material.get("url"))
                    if not zip_url.lower().endswith(".zip") or zip_url in seen_zip_urls:
                        continue
                    seen_zip_urls.add(zip_url)
                    tasks.append(
                        {
                            "company": company,
                            "productName": product_name,
                            "productType": product_type,
                            "salesStatus": "备案信息",
                            "url": zip_url,
                            "sourcePage": CATHAY_LIFE_FILING_URL,
                        }
                    )

            for task in tasks:
                status, content_type, data = await browser_fetch_bytes(page, trim(task.get("url")))
                if status in {405, 412} or not data.startswith(b"PK"):
                    try:
                        await page.goto(CATHAY_LIFE_FILING_URL, wait_until="networkidle", timeout=60000)
                        status, content_type, data = await browser_fetch_bytes(page, trim(task.get("url")))
                    except Exception:
                        status, content_type, data = 0, "", b""
                if status < 200 or status >= 300 or not data.startswith(b"PK"):
                    failed_downloads += 1
                    continue
                records.extend(cathay_life_records_from_filing_zip(task, data, content_type))
        finally:
            await browser.close()

    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    page_meta["recordCount"] = len(records)
    page_meta["failedDownloadCount"] = failed_downloads
    return {
        "ok": True,
        "company": company,
        "source": CATHAY_LIFE_FILING_URL,
        "maxProducts": max_products,
        "maxWorkers": 1,
        "pages": [page_meta],
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def crawl_cathay_life_filing_pages(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(crawl_cathay_life_filing_pages_async(payload))


def crawl_xintai_life_internet_products(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "信泰人寿"
    status_filter = xintai_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    try:
        status, html = fetch_html(XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL)
    except Exception:
        status, html = fetch_html_direct(XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL, referer=XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL)
    page_meta = {
        "url": XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL,
        "status": status,
        "saleStatus": ",".join(sorted(status_filter)),
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}

    products = xintai_life_internet_product_rows(company, html, status_filter, max_products)
    tasks: list[dict[str, str]] = []
    for product in products:
        tasks.append(
            {
                "company": company,
                "productName": product["productName"],
                "productType": product["productType"],
                "salesStatus": product["salesStatus"],
                "url": trim(product.get("materialUrl")),
            }
        )

    records = crawl_xintai_life_material_records(tasks, max_workers=max_workers)
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    page_meta["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": XINTAI_LIFE_INTERNET_PRODUCT_INFO_URL,
        "saleStatus": ",".join(sorted(status_filter)),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [page_meta],
        "products": [{key: value for key, value in product.items() if key != "materialUrl"} for product in products],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def metlife_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {*METLIFE_PRODUCT_PAGES.keys(), "dmtm"}
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return {"available"}
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return {"discontinued"}
    if text in {"dmtm", "telemarketing", "telemarket", "电销", "电话销售", "电销披露"}:
        return {"dmtm"}
    return {*METLIFE_PRODUCT_PAGES.keys(), "dmtm"}


def metlife_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "医疗" in product_name or "护理" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    if "团体" in product_name:
        return "团体保险"
    return ""


def metlife_material_type(label: str) -> str:
    if "说明" in label:
        return "product_manual"
    return "terms"


def extract_nuxt_strings(html: str) -> list[str]:
    soup = BeautifulSoup(html or "", "html.parser")
    script = soup.find("script", id="__NUXT_DATA__")
    if not script:
        return []
    try:
        payload = json.loads(script.get_text() or "[]")
    except Exception:
        return []
    strings: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, str):
            strings.append(value)
            return
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if isinstance(value, dict):
            for item in value.values():
                walk(item)

    walk(payload)
    return strings


def is_metlife_product_name(value: str, raw: str) -> bool:
    text = trim(value).replace("\ufeff", "")
    if (
        "中美联泰大都会人寿保险有限公司" not in text
        and "联泰大都会人寿保险有限公司" not in text
        and "中美大都会人寿保险有限公司" not in text
        and "花旗人寿保险有限公司" not in text
    ):
        return False
    if len(text) > 160:
        return False
    if "href=" in raw:
        return False
    if re.search(r"产品条款|产品费率表|产品现金价值|产品说明", raw):
        return False
    if re.search(r"公告|热线|隐私|ICP备|产品基本信息|最近更新", text):
        return False
    return True


def metlife_product_name_from_material_label(label: str) -> str:
    product_name = trim(label).replace("\ufeff", "")
    product_name = re.sub(r"^中美联泰大都会人寿保险有限公司\s*", "", product_name)
    product_name = re.sub(r"^联泰大都会人寿保险有限公司\s*", "", product_name)
    product_name = re.sub(r"^中美大都会人寿保险有限公司\s*", "", product_name)
    product_name = re.sub(r"^花旗人寿保险有限公司\s*", "", product_name)
    product_name = re.sub(r"\s+", "", product_name)
    product_name = product_name.replace("保险条款", "保险")
    product_name = product_name.replace("条款", "")
    product_name = re.sub(r"产品说明书?$", "", product_name)
    return product_name.strip(" ：:-")


def metlife_materials_from_content(content_html: str) -> list[dict[str, str]]:
    if "<a" not in (content_html or "").lower():
        return []
    soup = BeautifulSoup(content_html or "", "html.parser")
    materials: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for anchor in soup.find_all("a"):
        label = html_text(str(anchor)).replace("\ufeff", "").strip()
        href = trim(anchor.get("href"))
        if not label or not href:
            continue
        if "费率" in label or "现金价值" in label or EXCLUDED_MATERIAL_RE.search(label):
            continue
        if "条款" not in label and "产品说明" not in label and label != "产品说明":
            continue
        material_url = urljoin(METLIFE_OFFICIAL_BASE_URL, href)
        hostname = urlsplit(material_url).netloc.lower()
        if not hostname.endswith("metlife.com.cn"):
            continue
        if material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        materials.append(
            {
                "label": label,
                "type": metlife_material_type(label),
                "url": material_url,
            }
        )
    return materials


def metlife_product_rows(company: str, page_key: str, html: str) -> list[dict[str, Any]]:
    page = METLIFE_PRODUCT_PAGES[page_key]
    strings = extract_nuxt_strings(html)
    products: list[dict[str, Any]] = []
    seen_product_materials: set[str] = set()
    for index, raw in enumerate(strings):
        product_name = html_text(raw).replace("\ufeff", "").strip()
        if not is_metlife_product_name(product_name, raw):
            continue
        content_html = ""
        for candidate in strings[index + 1 : index + 7]:
            if ("产品条款" in candidate or "产品说明" in candidate) and ("strapi-uploads" in candidate or "content/dam" in candidate or "cms-blob" in candidate):
                content_html = candidate
                break
        materials = metlife_materials_from_content(content_html)
        if not materials:
            continue
        material_key = "|".join(sorted(material["url"] for material in materials))
        product_key = f"{page_key}|{product_name}|{material_key}"
        if product_key in seen_product_materials:
            continue
        seen_product_materials.add(product_key)
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": metlife_product_type(product_name),
                "salesStatus": page["salesStatus"],
                "sourcePage": page["url"],
                "sourceStatus": page_key,
                "materials": materials,
            }
        )
    return products


def metlife_dmtm_product_rows(company: str, html: str) -> list[dict[str, Any]]:
    strings = extract_nuxt_strings(html)
    products: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for raw in strings:
        for material in metlife_materials_from_content(raw):
            material_url = trim(material.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            product_name = metlife_product_name_from_material_label(material.get("label", ""))
            if not product_name:
                continue
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": metlife_product_type(product_name),
                    "salesStatus": METLIFE_DMTM_PAGE["salesStatus"],
                    "sourcePage": METLIFE_DMTM_PAGE["url"],
                    "sourceStatus": "dmtm",
                    "materials": [
                        {
                            "label": "产品说明书" if material.get("type") == "product_manual" else "产品条款",
                            "type": material.get("type") or metlife_material_type(material.get("label", "")),
                            "url": material_url,
                        }
                    ],
                }
            )
    return products


def crawl_metlife_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or METLIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "大都会人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"大都会人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or metlife_material_type(label),
        "official": True,
        "officialDomain": "metlife.com.cn",
        "parser": "scrapling_metlife_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_metlife_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_metlife_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_metlife_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_metlife_china_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "大都会人寿"
    status_keys = metlife_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()

    for page_key in ("available", "discontinued"):
        if page_key not in status_keys:
            continue
        page = METLIFE_PRODUCT_PAGES[page_key]
        status, html = fetch_html(page["url"])
        page_meta = {
            "url": page["url"],
            "status": status,
            "saleStatus": page["salesStatus"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            continue
        page_products = metlife_product_rows(company, page_key, html)
        for product in page_products:
            if max_products and len(products) >= max_products:
                break
            products.append({key: value for key, value in product.items() if key != "materials"})
            for material in product.get("materials", []):
                material_url = trim(material.get("url"))
                if not material_url or material_url in seen_task_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product["productName"],
                        "productType": product["productType"],
                        "salesStatus": product["salesStatus"],
                        "label": material["label"],
                        "materialType": material["type"],
                        "url": material_url,
                        "sourcePage": product["sourcePage"],
                    }
                )
        page_meta["productCount"] = len([product for product in products if product.get("sourceStatus") == page_key])
        page_meta["materialTaskCount"] = len([task for task in tasks if task.get("sourcePage") == page["url"]])
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    if (not max_products or len(products) < max_products) and "dmtm" in status_keys:
        page = METLIFE_DMTM_PAGE
        status, html = fetch_html(page["url"])
        page_meta = {
            "url": page["url"],
            "status": status,
            "saleStatus": page["salesStatus"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
        else:
            page_products = metlife_dmtm_product_rows(company, html)
            for product in page_products:
                if max_products and len(products) >= max_products:
                    break
                products.append({key: value for key, value in product.items() if key != "materials"})
                for material in product.get("materials", []):
                    material_url = trim(material.get("url"))
                    if not material_url or material_url in seen_task_urls:
                        continue
                    seen_task_urls.add(material_url)
                    tasks.append(
                        {
                            "company": company,
                            "productName": product["productName"],
                            "productType": product["productType"],
                            "salesStatus": product["salesStatus"],
                            "label": material["label"],
                            "materialType": material["type"],
                            "url": material_url,
                            "sourcePage": product["sourcePage"],
                        }
                    )
            page_meta["productCount"] = len([product for product in products if product.get("sourceStatus") == "dmtm"])
            page_meta["materialTaskCount"] = len([task for task in tasks if task.get("sourcePage") == page["url"]])
            pages.append(page_meta)

    records = crawl_metlife_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(page["url"], 0)

    return {
        "ok": True,
        "company": company,
        "source": "https://www.metlife.com.cn/information-disclosure/public-information-disclosure/basic-information/basic-product-information",
        "saleStatus": sorted(status_keys),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def abc_life_source_filter(value: str) -> set[str]:
    text = trim(value).lower()
    all_keys = {page["key"] for page in ABC_LIFE_PRODUCT_PAGES}
    if not text or text in {"all", "全部"}:
        return all_keys
    output: set[str] = set()
    tokens = re.split(r"[,，\s]+", text)
    for token in tokens:
        if not token:
            continue
        for page in ABC_LIFE_PRODUCT_PAGES:
            if token == page["key"] or token == page["group"]:
                output.add(page["key"])
        if token in {"main", "product", "product-info", "basic", "目录", "产品目录", "基本信息"}:
            output.update(page["key"] for page in ABC_LIFE_PRODUCT_PAGES if page["group"] == "main")
        if token in {"internet", "online", "hlw", "互联网", "互联网保险"}:
            output.update(page["key"] for page in ABC_LIFE_PRODUCT_PAGES if page["group"] == "internet")
        if token in {"manual", "manuals", "说明", "说明书", "产品说明书", "new-type", "新型"}:
            output.update(page["key"] for page in ABC_LIFE_PRODUCT_PAGES if page["group"] == "manual")
    return output or all_keys


def abc_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    output: set[str] = set()
    if text in {"sale", "on_sale", "available", "in_sale", "在售"} or "在售" in text:
        output.add("在售")
    if text in {"stop", "stopped", "off_sale", "discontinued", "停售"} or "停售" in text:
        output.add("停售")
    return output or {trim(value)}


def abc_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "团体" in name:
        return "团体保险"
    if "医疗" in name or "津贴" in name:
        return "医疗险"
    if "重大疾病" in name or "疾病" in name or "防癌" in name or "护理" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    return ""


def abc_life_clean_product_name(value: str) -> str:
    text = trim(value).lstrip("·•").strip()
    text = re.sub(r"\s+", "", text)
    return trim(text)


def abc_life_material_type(label: str, kind: str = "") -> str:
    text = trim(label)
    if kind == "direct_manual" or "产品说明" in text or "说明书" in text:
        return "product_manual"
    return "terms"


def abc_life_normalize_pdf_url(href: str, page_url: str) -> str:
    raw = trim(href)
    if not raw or raw.lower().startswith(("javascript:", "mailto:")):
        return ""
    material_url = urljoin(page_url, raw)
    parts = urlsplit(material_url)
    host = (parts.hostname or "").lower()
    if parts.scheme not in {"http", "https"} or host != ABC_LIFE_OFFICIAL_DOMAIN:
        return ""
    if not parts.path.lower().endswith(".pdf"):
        return ""
    return material_url


def abc_life_keep_material(label: str, material_url: str, kind: str = "") -> bool:
    text = clean_text(f"{label} {material_url}")
    if not material_url or ABC_LIFE_EXCLUDED_MATERIAL_RE.search(text):
        return False
    if kind in {"direct_manual", "direct_terms"}:
        return True
    return "条款" in text or "产品说明" in text or "说明书" in text


def abc_life_fetch_html(url: str) -> tuple[int, str]:
    return fetch_html_direct(url, referer=ABC_LIFE_OFFICIAL_BASE_URL)


def abc_life_paginated_urls(base_url: str, html: str) -> list[str]:
    soup = BeautifulSoup(html or "", "html.parser")
    urls: list[str] = []
    seen: set[str] = set()

    def add_url(href: str) -> None:
        page_url = urljoin(base_url, trim(href))
        if page_url and page_url not in seen:
            seen.add(page_url)
            urls.append(page_url)

    add_url(base_url)
    for option in soup.select("select option"):
        add_url(option.get("value") or "")
    if len(urls) == 1:
        for anchor in soup.find_all("a"):
            href = trim(anchor.get("href"))
            if re.search(r"index(?:_\d+)?\.shtml$", href):
                add_url(href)
    return urls


def parse_abc_life_table_page(
    company: str, page: dict[str, str], page_url: str, html: str, max_products: int
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        product_name = abc_life_clean_product_name(cells[0].get_text(" ", strip=True))
        if not product_name or product_name in {"保险产品名称", "产品名称"}:
            continue
        product_type = abc_life_product_type(product_name)
        product = {
            "company": company,
            "productName": product_name,
            "productType": product_type,
            "salesStatus": page["salesStatus"],
            "sourcePage": page_url,
            "sourceGroup": page["group"],
            "pageLabel": page["label"],
            "publicationDate": trim(cells[2].get_text(" ", strip=True)) if len(cells) > 2 else "",
        }
        products.append(product)
        for anchor in row.find_all("a"):
            label = html_text(str(anchor))
            material_url = abc_life_normalize_pdf_url(trim(anchor.get("href")), page_url)
            if not abc_life_keep_material(label, material_url, page["kind"]) or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": page["salesStatus"],
                    "label": label,
                    "materialType": abc_life_material_type(label, page["kind"]),
                    "url": material_url,
                    "sourcePage": page_url,
                    "sourceGroup": page["group"],
                    "pageLabel": page["label"],
                    "publicationDate": product["publicationDate"],
                }
            )
        if max_products and len(products) >= max_products:
            break
    return products, tasks


def parse_abc_life_direct_page(
    company: str, page: dict[str, str], page_url: str, html: str, max_products: int
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    label = "产品说明书" if page["kind"] == "direct_manual" else "互联网保险产品信息"
    for anchor in soup.find_all("a"):
        material_url = abc_life_normalize_pdf_url(trim(anchor.get("href")), page_url)
        product_name = abc_life_clean_product_name(html_text(str(anchor)))
        if not material_url or material_url in seen_urls or not product_name:
            continue
        if not abc_life_keep_material(label, material_url, page["kind"]):
            continue
        seen_urls.add(material_url)
        product_type = abc_life_product_type(product_name)
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": page["salesStatus"],
                "sourcePage": page_url,
                "sourceGroup": page["group"],
                "pageLabel": page["label"],
            }
        )
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": page["salesStatus"],
                "label": label,
                "materialType": abc_life_material_type(label, page["kind"]),
                "url": material_url,
                "sourcePage": page_url,
                "sourceGroup": page["group"],
                "pageLabel": page["label"],
            }
        )
        if max_products and len(products) >= max_products:
            break
    return products, tasks


def abc_life_responsibility_excerpt(text: str) -> str:
    return icbc_axa_responsibility_excerpt(text)


def crawl_abc_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    host = (urlsplit(material_url).hostname or "").lower()
    if host != ABC_LIFE_OFFICIAL_DOMAIN:
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or ABC_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = abc_life_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "产品条款"
    return {
        "company": trim(task.get("company")) or "农银人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or abc_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"农银人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or abc_life_material_type(label),
        "official": True,
        "officialDomain": ABC_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_abc_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_abc_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_abc_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_abc_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_abc_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "农银人寿"
    source_filter = abc_life_source_filter(trim(payload.get("source") or payload.get("page")))
    status_filter = abc_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    start_page = max(1, int(payload.get("startPage") or 1))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()

    for profile in ABC_LIFE_PRODUCT_PAGES:
        if profile["key"] not in source_filter or profile["salesStatus"] not in status_filter:
            continue
        if max_products and len(products) >= max_products:
            break
        first_status, first_html = abc_life_fetch_html(profile["url"])
        page_urls = abc_life_paginated_urls(profile["url"], first_html) if 200 <= first_status < 300 else [profile["url"]]
        for page_index, page_url in enumerate(page_urls, start=1):
            if page_index < start_page:
                continue
            if max_pages and page_index >= start_page + max_pages:
                break
            if max_products and len(products) >= max_products:
                break
            status, html = (first_status, first_html) if page_url == profile["url"] else abc_life_fetch_html(page_url)
            page_meta = {
                "url": page_url,
                "status": status,
                "pageNumber": page_index,
                "key": profile["key"],
                "group": profile["group"],
                "kind": profile["kind"],
                "label": profile["label"],
                "salesStatus": profile["salesStatus"],
                "productCount": 0,
                "materialTaskCount": 0,
                "recordCount": 0,
            }
            if status < 200 or status >= 300 or not html:
                pages.append(page_meta)
                continue
            remaining = max_products - len(products) if max_products else 0
            if profile["kind"] == "table":
                page_products, page_tasks = parse_abc_life_table_page(company, profile, page_url, html, remaining)
            else:
                page_products, page_tasks = parse_abc_life_direct_page(company, profile, page_url, html, remaining)
            products.extend(page_products)
            page_task_count = 0
            for task in page_tasks:
                material_url = trim(task.get("url"))
                if not material_url or material_url in seen_task_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append(task)
                page_task_count += 1
            page_meta["productCount"] = len(page_products)
            page_meta["materialTaskCount"] = page_task_count
            pages.append(page_meta)

    records = crawl_abc_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": ABC_LIFE_PRODUCT_INFO_URL,
        "officialDomain": ABC_LIFE_OFFICIAL_DOMAIN,
        "sourceFilter": sorted(source_filter),
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "startPage": start_page,
        "maxPages": max_pages,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def icbc_axa_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "医疗" in product_name or "护理" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def icbc_axa_material_type(label: str) -> str:
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    return "terms"


def icbc_axa_sales_status(label: str, is_history: bool) -> str:
    if not is_history:
        return "在售"
    if "停用" in label:
        return "历史版本（停用）"
    if "启用" in label:
        return "历史版本（启用）"
    return "历史版本"


def icbc_axa_responsibility_excerpt(text: str) -> str:
    normalized = clean_text(text)
    if not normalized:
        return ""
    candidates = []
    for match in re.finditer(r"保险责任", normalized):
        start = match.start()
        window = normalized[start : start + MAX_EXCERPT_CHARS]
        near = window[:900]
        score = 0
        if re.search(r"承担以下保险责任|在本合同保险期间|我们承担以下|我们按.*?给付", near):
            score += 4
        if re.search(r"保险金|赔偿|报销|医疗费用", near):
            score += 1
        if re.search(r"(?:\d+\s*\.\s*)+\d*\s*保险责任|第[一二三四五六七八九十百]+条\s*保险责任", normalized[max(0, start - 80) : start + 20]):
            score += 1
        if re.search(r"目录|条款目录|向您介绍该合同|请您特别注意", normalized[max(0, start - 220) : start + 260]):
            score -= 3
        if re.search(r"\d+\.\d+\s*保险责任\s+\d+\.\d+.*?责任免除.*?诉讼时效", near[:260]):
            score -= 4
        if "责任免除" in near[:180] and not re.search(r"给付|医疗费用|保险金|赔偿|报销", near[:180]):
            score -= 2
        candidates.append((score, start, window))
    if not candidates:
        return ""
    score, start, _window = max(candidates, key=lambda item: (item[0], -item[1]))
    if score <= 0:
        return focused_responsibility_excerpt(text)
    tail = normalized[start:]
    end_match = RESPONSIBILITY_END_RE.search(tail[120:])
    excerpt = tail[: 120 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
    sentences = re.split(r"(?<=[。；;])", excerpt)
    kept = []
    for sentence in sentences:
        item = sentence.strip()
        if not item:
            continue
        if any(keyword in item for keyword in RESPONSIBILITY_KEYWORDS):
            kept.append(item)
    output = "\n".join(kept).strip()
    return output[:MAX_EXCERPT_CHARS] if output else excerpt[:MAX_EXCERPT_CHARS]


def parse_icbc_axa_products(company: str, html: str, max_products: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in soup.select("tr.salesOnlineContent"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        product_name = trim(cells[0].get_text(" ", strip=True))
        if not product_name:
            continue
        product = {
            "company": company,
            "productName": product_name,
            "productType": icbc_axa_product_type(product_name),
            "salesStatus": "在售",
            "sourcePage": ICBC_AXA_PRODUCT_INFO_URL,
        }
        products.append(product)
        for cell_index, cell in enumerate(cells[1:], start=1):
            is_history = cell_index >= 2
            for anchor in cell.find_all("a"):
                label = trim(anchor.get_text(" ", strip=True))
                if "条款" not in label and "产品说明" not in label and "说明书" not in label:
                    continue
                href = trim(anchor.get("href"))
                material_url = urljoin(ICBC_AXA_OFFICIAL_BASE_URL, href)
                if not material_url or material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product["productType"],
                        "salesStatus": icbc_axa_sales_status(label, is_history),
                        "label": label,
                        "materialType": icbc_axa_material_type(label),
                        "url": material_url,
                        "pageUrl": ICBC_AXA_PRODUCT_INFO_URL,
                    }
                )
        if max_products and len(products) >= max_products:
            break
    if max_products:
        allowed = {product["productName"] for product in products}
        tasks = [task for task in tasks if task.get("productName") in allowed]
    return products, tasks


def crawl_icbc_axa_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("pageUrl")) or ICBC_AXA_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = icbc_axa_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "工银安盛",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")) or "在售",
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"工银安盛官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or icbc_axa_material_type(label),
        "official": True,
        "officialDomain": ICBC_AXA_OFFICIAL_DOMAIN,
        "parser": "scrapling_icbc_axa_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_icbc_axa_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_icbc_axa_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_icbc_axa_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_icbc_axa_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "工银安盛"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, html = fetch_html(ICBC_AXA_PRODUCT_INFO_URL)
    page_meta = {
        "url": ICBC_AXA_PRODUCT_INFO_URL,
        "status": status,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or "在售保险产品" not in html:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}
    products, tasks = parse_icbc_axa_products(company, html, max_products)
    records = crawl_icbc_axa_material_records(tasks, max_workers=max_workers)
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    page_meta["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": ICBC_AXA_PRODUCT_INFO_URL,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [page_meta],
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def aviva_cofco_life_product_type(product_name: str, fallback: str = "") -> str:
    if fallback:
        return fallback
    if "重大疾病" in product_name or "疾病" in product_name or "护理" in product_name:
        return "健康保险"
    if "医疗" in product_name or "津贴" in product_name:
        return "健康保险"
    if "意外" in product_name:
        return "意外伤害保险"
    if "年金" in product_name or "养老" in product_name or "教育" in product_name:
        return "年金保险"
    if "两全" in product_name or "寿险" in product_name:
        return "人寿保险"
    return fallback


def aviva_cofco_life_material_type(label: str) -> str:
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    return "terms"


def aviva_cofco_life_field(block: str, name: str) -> str:
    match = re.search(rf"{re.escape(name)}\s*:\s*\"((?:\\.|[^\"\\])*)\"", block, re.S)
    if not match:
        return ""
    value = match.group(1).replace(r"\/", "/").replace(r"\"", '"').replace(r"\\", "\\")
    return html_lib.unescape(value)


def aviva_cofco_life_version_values(value: str) -> list[str]:
    text = trim(value)
    if text == "0":
        return []
    if not text:
        return [""]
    return [trim(item) for item in text.split(",") if trim(item)] or [""]


def aviva_cofco_life_material_url(product_name: str, label: str, version: str = "") -> str:
    filename = f"{product_name}_{label}"
    if version:
        filename = f"{filename}_{version}"
    return urljoin(AVIVA_COFCO_LIFE_OFFICIAL_BASE_URL, f"static/pdf/product/{filename}.pdf")


def aviva_cofco_life_product_rows(company: str, page: dict[str, str], html: str, max_products: int) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    for match in re.finditer(r"archives\.push\(\s*\{(.*?)\}\s*\);", html or "", re.S):
        block = match.group(1)
        product_name = trim(aviva_cofco_life_field(block, "title"))
        if not product_name:
            continue
        product_key = f"{page['salesStatus']}|{product_name}"
        if product_key in seen_products:
            continue
        seen_products.add(product_key)
        product_type = aviva_cofco_life_product_type(product_name, trim(aviva_cofco_life_field(block, "author")))
        product = {
            "company": company,
            "productName": product_name,
            "productType": product_type,
            "salesStatus": page["salesStatus"],
            "sourcePage": page["url"],
            "productId": trim(aviva_cofco_life_field(block, "id")),
            "riskLevel": trim(aviva_cofco_life_field(block, "tag")),
            "materials": [],
        }
        material_fields = [
            ("subTitle", "条款"),
            ("link", "产品说明书"),
        ]
        for field_name, label in material_fields:
            for version in aviva_cofco_life_version_values(aviva_cofco_life_field(block, field_name)):
                product["materials"].append(
                    {
                        "label": label if not version else f"{label}（{version}）",
                        "baseLabel": label,
                        "version": version,
                        "type": aviva_cofco_life_material_type(label),
                        "url": aviva_cofco_life_material_url(product_name, label, version),
                    }
                )
        if not product["materials"]:
            continue
        products.append(product)
        if max_products and len(products) >= max_products:
            break
    return products


def crawl_aviva_cofco_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or AVIVA_COFCO_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or trim(task.get("baseLabel"))
    return {
        "company": trim(task.get("company")) or "中英人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"中英人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or aviva_cofco_life_material_type(label),
        "official": True,
        "officialDomain": AVIVA_COFCO_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_aviva_cofco_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_aviva_cofco_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_aviva_cofco_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_aviva_cofco_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def aviva_cofco_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if not text or text == "all":
        return {"在售", "停售"}
    output: set[str] = set()
    if "在售" in text or text in {"available", "sale", "on_sale"}:
        output.add("在售")
    if "停售" in text or text in {"stopped", "discontinued", "off_sale"}:
        output.add("停售")
    return output or {"在售", "停售"}


def crawl_aviva_cofco_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中英人寿"
    status_filter = aviva_cofco_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()

    for page in AVIVA_COFCO_LIFE_PRODUCT_PAGES:
        if page["salesStatus"] not in status_filter:
            continue
        status, html = fetch_html(page["url"])
        page_meta = {
            "url": page["url"],
            "status": status,
            "salesStatus": page["salesStatus"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            continue
        remaining = max_products - len(products) if max_products else 0
        page_products = aviva_cofco_life_product_rows(company, page, html, remaining)
        for product in page_products:
            if max_products and len(products) >= max_products:
                break
            products.append({key: value for key, value in product.items() if key != "materials"})
            for material in product.get("materials", []):
                material_url = trim(material.get("url"))
                if not material_url or material_url in seen_task_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product["productName"],
                        "productType": product["productType"],
                        "salesStatus": product["salesStatus"],
                        "label": material["label"],
                        "baseLabel": material["baseLabel"],
                        "materialType": material["type"],
                        "url": material_url,
                        "sourcePage": product["sourcePage"],
                    }
                )
        page_meta["productCount"] = len([product for product in products if product.get("sourcePage") == page["url"]])
        page_meta["materialTaskCount"] = len([task for task in tasks if task.get("sourcePage") == page["url"]])
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    records = crawl_aviva_cofco_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(page["url"], 0)

    return {
        "ok": True,
        "company": company,
        "source": "https://www.aviva-cofco.com.cn/website/xxzx/gkxxpl/gsjbxx/grbxcpxx/",
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def greatwall_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"available", "discontinued"}
    if text in {"available", "in_sale", "sale", "在售", "on_sale"}:
        return {"available"}
    if text in {"discontinued", "stopped", "stop", "停售", "off_sale"}:
        return {"discontinued"}
    output: set[str] = set()
    if "在售" in text:
        output.add("available")
    if "停售" in text:
        output.add("discontinued")
    return output or {"available", "discontinued"}


def greatwall_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "医疗" in name:
        return "医疗险"
    if "护理" in name or "重大疾病" in name or "疾病" in name or "特定疾病" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    if "团体" in name:
        return "团体保险"
    return ""


def greatwall_life_clean_product_name(value: str) -> str:
    text = trim(value)
    text = re.sub(r"\s*[（(]\s*版本停用日期为[^）)]*[）)]\s*$", "", text)
    return trim(text)


def greatwall_life_product_list_url(action: str, page_number: int) -> str:
    return f"{GREATWALL_LIFE_OFFICIAL_BASE_URL}site/doc.action?action={action}&keyword=&page={page_number}"


def greatwall_life_material_type(label: str) -> str:
    return "product_manual" if "说明" in trim(label) else "terms"


def greatwall_life_keep_material(label: str, material_url: str) -> bool:
    text = trim(label)
    if text not in {"产品条款", "产品说明书"}:
        return False
    parts = urlsplit(material_url)
    hostname = parts.netloc.lower()
    return parts.scheme in {"http", "https"} and hostname.endswith(GREATWALL_LIFE_OFFICIAL_DOMAIN) and parts.path.lower().endswith(".pdf")


def parse_greatwall_life_product_page(company: str, profile: dict[str, str], page_number: int) -> dict[str, Any]:
    page_url = greatwall_life_product_list_url(profile["action"], page_number)
    status, html = fetch_html_direct(page_url, referer=GREATWALL_LIFE_PRODUCT_INFO_URL)
    page_meta = {
        "url": page_url,
        "status": status,
        "salesStatus": profile["salesStatus"],
        "pageNumber": page_number,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300:
        return {"page": page_meta, "products": []}

    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    for row in soup.select(".jbxx_table tbody tr"):
        cells = row.find_all("td")
        if len(cells) < 3:
            continue
        product_name = greatwall_life_clean_product_name(cells[1].get_text(" ", strip=True))
        if not product_name:
            continue
        product_type = greatwall_life_product_type(product_name)
        materials: list[dict[str, str]] = []
        seen_material_urls: set[str] = set()
        for anchor in cells[2].find_all("a"):
            label = html_text(str(anchor))
            href = trim(anchor.get("href"))
            if not href or href.lower().startswith("javascript"):
                continue
            material_url = urljoin(page_url, href)
            if not greatwall_life_keep_material(label, material_url) or material_url in seen_material_urls:
                continue
            seen_material_urls.add(material_url)
            materials.append(
                {
                    "label": label,
                    "type": greatwall_life_material_type(label),
                    "url": material_url,
                }
            )
        if not materials:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": profile["salesStatus"],
                "sourcePage": page_url,
                "sourceAction": profile["action"],
                "filingDate": trim(cells[3].get_text(" ", strip=True)) if len(cells) > 3 else "",
                "productLevel": trim(cells[4].get_text(" ", strip=True)) if len(cells) > 4 else "",
                "accountRiskLevel": trim(cells[5].get_text(" ", strip=True)) if len(cells) > 5 else "",
                "materials": materials,
            }
        )
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = sum(len(product.get("materials", [])) for product in products)
    return {"page": page_meta, "products": products}


def crawl_greatwall_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    if not urlsplit(material_url).netloc.lower().endswith(GREATWALL_LIFE_OFFICIAL_DOMAIN):
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or GREATWALL_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "长城人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or greatwall_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"长城人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or greatwall_life_material_type(label),
        "official": True,
        "officialDomain": GREATWALL_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_greatwall_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_greatwall_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_greatwall_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_greatwall_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_greatwall_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "长城人寿"
    status_filter = greatwall_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_pages = max(1, int(payload.get("maxPages") or 100))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()
    seen_product_keys: set[str] = set()

    for profile in GREATWALL_LIFE_PRODUCT_PAGES:
        status_key = "available" if profile["action"] == "queryProDocList" else "discontinued"
        if status_key not in status_filter:
            continue
        seen_first_names: set[str] = set()
        for page_number in range(1, max_pages + 1):
            page_result = parse_greatwall_life_product_page(company, profile, page_number)
            page_products = page_result["products"]
            if not page_products:
                break
            first_name = trim(page_products[0].get("productName"))
            if first_name in seen_first_names:
                break
            seen_first_names.add(first_name)

            selected_products = 0
            selected_tasks = 0
            for product in page_products:
                if max_products and len(products) >= max_products:
                    break
                product_key = f"{profile['action']}|{product['productName']}"
                if product_key not in seen_product_keys:
                    seen_product_keys.add(product_key)
                    products.append({key: value for key, value in product.items() if key != "materials"})
                    selected_products += 1
                for material in product.get("materials", []):
                    material_url = trim(material.get("url"))
                    if not material_url or material_url in seen_task_urls:
                        continue
                    seen_task_urls.add(material_url)
                    tasks.append(
                        {
                            "company": company,
                            "productName": trim(product.get("productName")),
                            "productType": trim(product.get("productType")),
                            "salesStatus": trim(product.get("salesStatus")),
                            "label": trim(material.get("label")),
                            "materialType": trim(material.get("type")),
                            "url": material_url,
                            "sourcePage": trim(product.get("sourcePage")),
                        }
                    )
                    selected_tasks += 1
            page_meta = page_result["page"]
            page_meta["productCount"] = selected_products
            page_meta["materialTaskCount"] = selected_tasks
            pages.append(page_meta)
            if max_products and len(products) >= max_products:
                break

    records = crawl_greatwall_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": GREATWALL_LIFE_PRODUCT_INFO_URL,
        "officialDomain": GREATWALL_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxPages": max_pages,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def guofu_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"available", "discontinued"}
    if text in {"available", "in_sale", "sale", "在售", "on_sale"}:
        return {"available"}
    if text in {"discontinued", "stopped", "stop", "停售", "off_sale"}:
        return {"discontinued"}
    output: set[str] = set()
    if "在售" in text:
        output.add("available")
    if "停售" in text:
        output.add("discontinued")
    return output or {"available", "discontinued"}


def guofu_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "医疗" in name:
        return "医疗险"
    if "护理" in name or "重大疾病" in name or "疾病" in name or "特定疾病" in name or "癌" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    if "团体" in name:
        return "团体保险"
    return ""


def guofu_life_material_type(label: str) -> str:
    return "product_manual" if "说明" in trim(label) else "terms"


def guofu_life_material_url(path_value: str) -> str:
    value = trim(path_value)
    if not value:
        return ""
    return urljoin(GUOFU_LIFE_OFFICIAL_BASE_URL, value)


def guofu_life_keep_material(material_url: str) -> bool:
    parts = urlsplit(material_url)
    return parts.scheme in {"http", "https"} and parts.netloc.lower().endswith(GUOFU_LIFE_OFFICIAL_DOMAIN) and parts.path.lower().endswith(".pdf")


def fetch_guofu_life_products(profile: dict[str, str], page_size: int = 20000) -> tuple[int, dict[str, Any]]:
    query = urlencode(
        {
            "categoryId": profile["categoryId"],
            "title": "",
            "pageNum": "1",
            "pageSize": str(page_size),
        }
    )
    status, html = fetch_html_direct(f"{GUOFU_LIFE_PRODUCT_API}?{query}", referer=profile["referer"])
    if status < 200 or status >= 300:
        return status, {}
    try:
        return status, json.loads(html)
    except Exception:
        return status, {}


def parse_guofu_life_products(company: str, profile: dict[str, str], max_products: int = 0, product_offset: int = 0) -> dict[str, Any]:
    status, payload = fetch_guofu_life_products(profile)
    rows = payload.get("data") if isinstance(payload.get("data"), list) else []
    total = int(rows[0].get("all") or len(rows)) if rows and isinstance(rows[0], dict) else len(rows)
    selected_rows = rows[product_offset:] if product_offset > 0 else rows
    page_meta = {
        "url": f"{GUOFU_LIFE_PRODUCT_API}?categoryId={profile['categoryId']}",
        "sourcePage": profile["referer"],
        "status": status,
        "salesStatus": profile["salesStatus"],
        "categoryId": profile["categoryId"],
        "totalProducts": total,
        "productOffset": product_offset,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not rows:
        return {"page": page_meta, "products": [], "tasks": []}

    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for row in selected_rows:
        if not isinstance(row, dict):
            continue
        if max_products and len(products) >= max_products:
            break
        product_name = trim(row.get("title"))
        if not product_name:
            continue
        attrs = row.get("attributeData") if isinstance(row.get("attributeData"), dict) else {}
        product_type = guofu_life_product_type(product_name)
        product = {
            "company": company,
            "productName": product_name,
            "productType": product_type,
            "salesStatus": profile["salesStatus"],
            "sourcePage": profile["referer"],
            "sourceStatus": profile["key"],
            "categoryId": profile["categoryId"],
            "productLevel": trim(attrs.get("classiFication")),
            "startDate": trim(attrs.get("startDate")),
            "stopDate": trim(attrs.get("stopDate")),
        }
        material_specs = [
            ("产品条款", "terms", attrs.get("productTK")),
            ("产品说明书", "product_manual", attrs.get("productDescri")),
        ]
        product_tasks: list[dict[str, str]] = []
        for label, material_type, path_value in material_specs:
            material_url = guofu_life_material_url(path_value)
            if not material_url or not guofu_life_keep_material(material_url):
                continue
            product_tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": profile["salesStatus"],
                    "label": label,
                    "materialType": material_type,
                    "url": material_url,
                    "sourcePage": profile["referer"],
                }
            )
        if not product_tasks:
            continue
        products.append(product)
        tasks.extend(product_tasks)
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_guofu_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not guofu_life_keep_material(material_url):
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or GUOFU_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "国富人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or guofu_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"国富人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or guofu_life_material_type(label),
        "official": True,
        "officialDomain": GUOFU_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_guofu_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_guofu_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_guofu_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_guofu_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_guofu_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "国富人寿"
    status_filter = guofu_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("productOffset") or payload.get("offset") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for profile in GUOFU_LIFE_PRODUCT_CATEGORIES:
        if profile["key"] not in status_filter:
            continue
        remaining = max(0, max_products - len(products)) if max_products else 0
        page_result = parse_guofu_life_products(company, profile, remaining, product_offset=product_offset)
        pages.append(page_result["page"])
        products.extend(page_result["products"])
        for task in page_result["tasks"]:
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
        if max_products and len(products) >= max_products:
            break

    records = crawl_guofu_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("sourcePage")), 0)

    return {
        "ok": True,
        "company": company,
        "source": GUOFU_LIFE_PRODUCT_INFO_URL,
        "officialDomain": GUOFU_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "productOffset": product_offset,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def china_post_life_product_type(product_name: str) -> str:
    if "医疗" in product_name:
        return "医疗险"
    if "重大疾病" in product_name or "疾病" in product_name or "护理" in product_name:
        return "健康险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name or "教育" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def china_post_life_material_type(label: str) -> str:
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    return "terms"


def china_post_life_index_page_url(base_url: str, page_number: int) -> str:
    if page_number <= 1:
        return base_url
    return urljoin(base_url, f"index_{page_number}.html")


def china_post_life_total_pages(html: str) -> int:
    counts = [int(match.group(1)) for match in re.finditer(r"createPageHTML(?:App)?\(\s*(\d+),", html or "")]
    return max(counts) if counts else 1


def china_post_life_split_multi(value: str) -> list[str]:
    return [trim(item) for item in re.split(r"\s*[;；]\s*", value or "") if trim(item)]


def china_post_life_product_name_from_label(label: str) -> str:
    value = trim(label)
    value = re.sub(r"\.pdf$", "", value, flags=re.I)
    value = re.sub(r"^\d+", "", value).strip()
    value = re.sub(r"[-_－—]?\s*基础材料\s*[-_－—]?\s*条款$", "", value).strip()
    value = re.sub(r"[-_－—]?\s*条款$", "", value).strip()
    value = re.sub(r"产品说明书?$", "", value).strip()
    return value


def extract_china_post_life_listing_products(page_profile: dict[str, str], page_number: int) -> dict[str, Any]:
    page_url = china_post_life_index_page_url(page_profile["url"], page_number)
    status, html = fetch_html(page_url)
    page_meta = {
        "url": page_url,
        "status": status,
        "salesStatus": page_profile["salesStatus"],
        "totalPages": china_post_life_total_pages(html),
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if status < 200 or status >= 300:
        return {"page": page_meta, "products": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    pattern = r"/publish/publish1/publish1_3/publish1_3_[12]/\d{6}/t\d+_\d+\.html$"
    for anchor in soup.find_all("a"):
        detail_url = urljoin(page_url, trim(anchor.get("href")))
        if not re.search(pattern, detail_url):
            continue
        product_name = trim(anchor.get_text(" ", strip=True))
        if not product_name or detail_url in seen_urls:
            continue
        seen_urls.add(detail_url)
        products.append(
            {
                "company": "中邮人寿",
                "productName": product_name,
                "productType": china_post_life_product_type(product_name),
                "salesStatus": page_profile["salesStatus"],
                "sourcePage": page_url,
                "detailUrl": detail_url,
            }
        )
    page_meta["productCount"] = len(products)
    return {"page": page_meta, "products": products}


def extract_china_post_life_detail_tasks(product: dict[str, str]) -> list[dict[str, str]]:
    detail_url = trim(product.get("detailUrl"))
    status, html = fetch_html(detail_url)
    if status < 200 or status >= 300:
        return []
    soup = BeautifulSoup(html, "html.parser")
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for anchor in soup.find_all("a"):
        href = trim(anchor.get("href"))
        if not href or ".pdf" not in href.lower():
            continue
        label = trim(anchor.get("title")) or trim(anchor.get_text(" ", strip=True))
        if "条款" not in label and "产品说明" not in label and "说明书" not in label:
            continue
        material_url = urljoin(detail_url, href)
        if material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        tasks.append(
            {
                "company": "中邮人寿",
                "productName": trim(product.get("productName")) or china_post_life_product_name_from_label(label),
                "productType": trim(product.get("productType")),
                "salesStatus": trim(product.get("salesStatus")),
                "label": label,
                "materialType": china_post_life_material_type(label),
                "url": material_url,
                "pageUrl": detail_url,
            }
        )
    return tasks


def extract_china_post_life_internet_page(company: str, max_products: int = 0) -> dict[str, Any]:
    status, html = fetch_html(CHINA_POST_LIFE_INTERNET_PRODUCTS_URL)
    page_meta = {
        "url": CHINA_POST_LIFE_INTERNET_PRODUCTS_URL,
        "status": status,
        "salesStatus": "互联网保险产品信息",
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if status < 200 or status >= 300:
        return {"page": page_meta, "products": [], "tasks": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    seen_product_keys: set[str] = set()
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        paths_node = row.find(class_="xgfj")
        labels_node = row.find(class_="xgfjmc")
        names_node = row.find(class_="sybt")
        if not paths_node or not labels_node:
            continue
        cells = row.find_all("td")
        sales_status = trim(cells[6].get_text(" ", strip=True)) if len(cells) > 6 else "官网未披露"
        paths = china_post_life_split_multi(paths_node.get_text(";", strip=True))
        labels = china_post_life_split_multi(labels_node.get_text(";", strip=True))
        names = china_post_life_split_multi(names_node.get_text(";", strip=True) if names_node else "")
        if not names and len(cells) > 2:
            names = china_post_life_split_multi(cells[2].get_text(";", strip=True))
        for index, path in enumerate(paths):
            label = labels[index] if index < len(labels) else path.rsplit("/", 1)[-1]
            if "条款" not in label and "产品说明" not in label and "说明书" not in label:
                continue
            product_name = names[index] if index < len(names) else china_post_life_product_name_from_label(label)
            if not product_name:
                continue
            product_key = f"{product_name}|{sales_status}"
            if product_key not in seen_product_keys:
                seen_product_keys.add(product_key)
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": china_post_life_product_type(product_name),
                        "salesStatus": sales_status,
                        "sourcePage": CHINA_POST_LIFE_INTERNET_PRODUCTS_URL,
                    }
                )
            material_url = urljoin(CHINA_POST_LIFE_INTERNET_PRODUCTS_URL, path)
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": china_post_life_product_type(product_name),
                    "salesStatus": sales_status,
                    "label": label,
                    "materialType": china_post_life_material_type(label),
                    "url": material_url,
                    "pageUrl": CHINA_POST_LIFE_INTERNET_PRODUCTS_URL,
                }
            )
            if max_products and len(seen_product_keys) >= max_products:
                break
        if max_products and len(seen_product_keys) >= max_products:
            break
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def china_post_life_clean_product_title(value: str) -> str:
    return re.sub(r"\s*\d{4}-\d{2}-\d{2}\s*$", "", trim(value)).strip()


def extract_china_post_life_product_center_page(company: str, max_products: int = 0) -> dict[str, Any]:
    status, html = fetch_html(CHINA_POST_LIFE_PRODUCT_CENTER_URL)
    total_pages = china_post_life_total_pages(html)
    page_meta = {
        "url": CHINA_POST_LIFE_PRODUCT_CENTER_URL,
        "status": status,
        "salesStatus": "产品中心",
        "totalPages": total_pages,
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if status < 200 or status >= 300:
        return {"page": page_meta, "products": [], "tasks": []}
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    seen_detail_urls: set[str] = set()
    for page_number in range(1, total_pages + 1):
        page_url = china_post_life_index_page_url(CHINA_POST_LIFE_PRODUCT_CENTER_URL, page_number)
        page_status, page_html = fetch_html(page_url)
        if page_status < 200 or page_status >= 300:
            continue
        soup = BeautifulSoup(page_html, "html.parser")
        for anchor in soup.find_all("a"):
            detail_url = urljoin(page_url, trim(anchor.get("href")))
            if not re.search(r"/product/product1/\d{6}/t\d+_\d+\.html$", detail_url):
                continue
            product_name = china_post_life_clean_product_title(anchor.get_text(" ", strip=True))
            if not product_name or detail_url in seen_detail_urls:
                continue
            seen_detail_urls.add(detail_url)
            product = {
                "company": company,
                "productName": product_name,
                "productType": china_post_life_product_type(product_name),
                "salesStatus": "官网未披露",
                "sourcePage": page_url,
                "detailUrl": detail_url,
            }
            products.append(product)
            for task in extract_china_post_life_detail_tasks(product):
                tasks.append({**task, "company": company})
            if max_products and len(products) >= max_products:
                break
        if max_products and len(products) >= max_products:
            break
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_china_post_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("pageUrl")) or CHINA_POST_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = icbc_axa_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "中邮人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or china_post_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"中邮人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or china_post_life_material_type(label),
        "official": True,
        "officialDomain": "chinapost-life.com",
        "parser": "scrapling_china_post_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_china_post_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_china_post_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_china_post_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_china_post_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中邮人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()

    for page_profile in CHINA_POST_LIFE_PRODUCT_LIST_PAGES:
        first_page = extract_china_post_life_listing_products(page_profile, 1)
        total_pages = int(first_page["page"].get("totalPages") or 1)
        for page_result in [first_page] + [extract_china_post_life_listing_products(page_profile, page_number) for page_number in range(2, total_pages + 1)]:
            page_tasks: list[dict[str, str]] = []
            for product in page_result["products"]:
                if max_products and len(seen_products) >= max_products:
                    break
                product_key = f"{product['productName']}|{product['salesStatus']}"
                if product_key not in seen_products:
                    seen_products.add(product_key)
                    products.append({**product, "company": company})
                for task in extract_china_post_life_detail_tasks(product):
                    material_url = trim(task.get("url"))
                    if not material_url or material_url in seen_urls:
                        continue
                    seen_urls.add(material_url)
                    task = {**task, "company": company}
                    tasks.append(task)
                    page_tasks.append(task)
            page_meta = page_result["page"]
            page_meta["materialTaskCount"] = len(page_tasks)
            pages.append(page_meta)
            if max_products and len(seen_products) >= max_products:
                break
        if max_products and len(seen_products) >= max_products:
            break

    if not max_products or len(seen_products) < max_products:
        internet_limit = max(0, max_products - len(seen_products)) if max_products else 0
        internet_page = extract_china_post_life_internet_page(company, internet_limit)
        internet_tasks = []
        for product in internet_page["products"]:
            product_key = f"{product['productName']}|{product['salesStatus']}"
            if product_key not in seen_products:
                seen_products.add(product_key)
                products.append(product)
        for task in internet_page["tasks"]:
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
            internet_tasks.append(task)
        internet_page["page"]["materialTaskCount"] = len(internet_tasks)
        pages.append(internet_page["page"])

    if not max_products or len(seen_products) < max_products:
        center_limit = max(0, max_products - len(seen_products)) if max_products else 0
        center_page = extract_china_post_life_product_center_page(company, center_limit)
        center_tasks = []
        for product in center_page["products"]:
            product_key = f"{product['productName']}|{product['salesStatus']}"
            if product_key not in seen_products:
                seen_products.add(product_key)
                products.append(product)
        for task in center_page["tasks"]:
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
            center_tasks.append(task)
        center_page["page"]["materialTaskCount"] = len(center_tasks)
        pages.append(center_page["page"])

    records = crawl_china_post_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("pageUrl")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(page["url"], 0)
    return {
        "ok": True,
        "company": company,
        "source": "https://www.chinapost-life.com/publish/publish1/publish1_3/",
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def post_json_direct(url: str, payload: dict[str, Any], referer: str = "", origin: str = "") -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            "Accept: application/json, text/plain, */*",
            "-H",
            "Content-Type: application/json; charset=UTF-8",
            "-H",
            f"Origin: {origin or CMRH_LIFE_OFFICIAL_BASE_URL.rstrip('/')}",
            "-H",
            f"Referer: {referer or CMRH_LIFE_PRODUCT_INFO_URL}",
            "-w",
            "\n%{http_code}",
            "--data-binary",
            json.dumps(payload, ensure_ascii=False),
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=45,
    )
    if proc.returncode != 0:
        return 0, {}
    output = proc.stdout.decode("utf-8", "ignore")
    body, _, status_text = output.rpartition("\n")
    status = int(status_text) if status_text.isdigit() else 200
    try:
        return status, json.loads(body)
    except Exception:
        return status, {}


def cmrh_life_status_filter(value: str) -> list[str]:
    text = trim(value)
    if text in {"", "all", "全部"}:
        return ["ON_SALE", "SALE_END"]
    result: list[str] = []
    for token in re.split(r"[,，\s]+", text):
        upper = token.upper()
        if upper in {"ON_SALE", "ONSALE", "IN_SALE", "INSALE", "AVAILABLE"} or "在售" in token:
            result.append("ON_SALE")
        elif upper in {"SALE_END", "SALEEND", "STOPPED", "DISCONTINUED"} or "停售" in token:
            result.append("SALE_END")
    return list(dict.fromkeys(result)) or ["ON_SALE", "SALE_END"]


def cmrh_life_product_type(product_name: str) -> str:
    if "医疗" in product_name:
        return "医疗险"
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "护理" in product_name:
        return "护理险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return ""


def cmrh_life_material_content(item: dict[str, Any]) -> dict[str, Any]:
    content = item.get("dataContent")
    if isinstance(content, dict):
        return content
    if not isinstance(content, str) or not content.strip():
        return {}
    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def cmrh_life_material_type(data_type: str, label: str = "") -> str:
    if data_type == "INSTRUCTIONS_URL" or "产品说明" in label or "说明书" in label:
        return "product_manual"
    return "terms"


def cmrh_life_absolute_url(file_url: str) -> str:
    if not file_url:
        return ""
    return urljoin(CMRH_LIFE_OFFICIAL_BASE_URL, file_url)


def cmrh_life_sales_status(item: dict[str, Any]) -> str:
    status = trim(item.get("productStatus"))
    label = CMRH_LIFE_PRODUCT_STATUS_OPTIONS.get(status, status or "官网未披露")
    sale_end_date = trim(item.get("saleEndDate"))
    if status == "SALE_END" and sale_end_date:
        return f"{label}（{sale_end_date}）"
    return label


def fetch_cmrh_life_product_page(product_status: str, page_number: int, page_size: int) -> tuple[int, dict[str, Any]]:
    return post_json_direct(
        CMRH_LIFE_PRODUCT_LIST_ENDPOINT,
        {"pageNum": page_number, "pageSize": page_size, "productStatus": product_status},
        referer=CMRH_LIFE_PRODUCT_INFO_URL,
        origin=CMRH_LIFE_OFFICIAL_BASE_URL.rstrip("/"),
    )


def fetch_cmrh_life_pdf(url: str, referer: str = "") -> tuple[int, bytes]:
    last_status = 0
    last_data = b""
    for _attempt in range(3):
        status, data = fetch_bytes_direct(url, referer=referer or CMRH_LIFE_PRODUCT_INFO_URL)
        last_status = status
        last_data = data
        if status >= 200 and status < 300 and data and b"%PDF" in data[:20]:
            return status, data
    status, data = fetch_bytes_direct_limited(url, referer=referer or CMRH_LIFE_PRODUCT_INFO_URL, max_bytes=MAX_PDF_BYTES, max_time=70)
    if status >= 200 and status < 300 and data and b"%PDF" in data[:20]:
        return status, data
    last_status = status or last_status
    last_data = data or last_data
    return last_status, last_data


def extract_cmrh_life_product_page(company: str, product_status: str, page_number: int, page_size: int) -> dict[str, Any]:
    http_status, payload = fetch_cmrh_life_product_page(product_status, page_number, page_size)
    data = payload.get("data") if isinstance(payload, dict) else {}
    rows = data.get("list") if isinstance(data, dict) else []
    total = int(data.get("total") or 0) if isinstance(data, dict) else 0
    page_meta = {
        "url": CMRH_LIFE_PRODUCT_INFO_URL,
        "status": http_status,
        "apiCode": trim(payload.get("code")) if isinstance(payload, dict) else "",
        "productStatus": product_status,
        "salesStatus": CMRH_LIFE_PRODUCT_STATUS_OPTIONS.get(product_status, product_status),
        "pageNumber": page_number,
        "pageSize": page_size,
        "total": total,
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if http_status < 200 or http_status >= 300 or not isinstance(rows, list):
        return {"page": page_meta, "products": [], "tasks": []}

    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        product_name = trim(item.get("productName"))
        if not product_name:
            continue
        product_id = trim(item.get("id"))
        sales_status = cmrh_life_sales_status(item)
        product_type = cmrh_life_product_type(product_name)
        product = {
            "company": company,
            "productId": product_id,
            "productName": product_name,
            "productType": product_type,
            "salesStatus": sales_status,
            "sourcePage": CMRH_LIFE_PRODUCT_INFO_URL,
            "saleStartDate": trim(item.get("saleStartDate")),
            "saleEndDate": trim(item.get("saleEndDate")),
        }
        products.append(product)
        for material in item.get("exList") or []:
            if not isinstance(material, dict):
                continue
            data_type = trim(material.get("dataType"))
            if data_type not in {"ITEM_URL", "INSTRUCTIONS_URL"}:
                continue
            content = cmrh_life_material_content(material)
            label = trim(content.get("resourceName")) or ("产品说明书" if data_type == "INSTRUCTIONS_URL" else "产品条款")
            file_url = trim(content.get("downloadFileUrl") or content.get("previewFileUrl") or content.get("fileUrl") or content.get("url"))
            material_url = cmrh_life_absolute_url(file_url)
            if not material_url:
                continue
            tasks.append(
                {
                    "company": company,
                    "productId": product_id,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "label": label,
                    "materialType": cmrh_life_material_type(data_type, label),
                    "url": material_url,
                    "pageUrl": CMRH_LIFE_PRODUCT_INFO_URL,
                    "dataType": data_type,
                }
            )
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_cmrh_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    pdf_status, data = fetch_cmrh_life_pdf(material_url, referer=trim(task.get("pageUrl")) or CMRH_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or not data or len(data) > MAX_PDF_BYTES or b"%PDF" not in data[:20]:
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = icbc_axa_responsibility_excerpt(extracted.get("text", "")) or focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    official_domain = urlsplit(material_url).netloc or "www.cmrh.com"
    return {
        "company": trim(task.get("company")) or "招商仁和",
        "productName": product_name,
        "productType": trim(task.get("productType")) or cmrh_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")) or "官网未披露",
        "title": f"{product_name} {label}".strip(),
        "url": material_url,
        "snippet": f"招商仁和官网{label or '产品资料'}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or cmrh_life_material_type(trim(task.get("dataType")), label),
        "official": True,
        "officialDomain": official_domain,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "parser": "scrapling_cmrh_life_product_info",
    }


def crawl_cmrh_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_cmrh_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_cmrh_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_cmrh_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "招商仁和"
    status_keys = cmrh_life_status_filter(trim(payload.get("saleStatus") or payload.get("salesStatus") or payload.get("productStatus")))
    page_size = min(100, max(1, int(payload.get("pageSize") or 100)))
    start_page = max(1, int(payload.get("startPage") or 1))
    end_page = max(0, int(payload.get("endPage") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_product_keys: set[str] = set()
    seen_task_urls: set[str] = set()

    for status_key in status_keys:
        first_page = extract_cmrh_life_product_page(company, status_key, 1, page_size)
        total = int(first_page["page"].get("total") or 0)
        total_pages = max(1, (total + page_size - 1) // page_size)
        selected_end_page = min(total_pages, end_page or total_pages)
        if start_page > selected_end_page:
            page_results = []
        elif start_page == 1:
            page_results = [first_page] + [
                extract_cmrh_life_product_page(company, status_key, page_number, page_size)
                for page_number in range(2, selected_end_page + 1)
            ]
        else:
            page_results = [
                extract_cmrh_life_product_page(company, status_key, page_number, page_size)
                for page_number in range(start_page, selected_end_page + 1)
            ]
        for page_result in page_results:
            page_selected_product_keys: set[str] = set()
            page_task_count = 0
            for product in page_result["products"]:
                product_key = trim(product.get("productId")) or f"{product.get('productName')}|{product.get('salesStatus')}"
                if not product_key:
                    continue
                if product_key not in seen_product_keys:
                    if max_products and len(seen_product_keys) >= max_products:
                        continue
                    seen_product_keys.add(product_key)
                    products.append(product)
                if product_key in seen_product_keys:
                    page_selected_product_keys.add(product_key)
            for task in page_result["tasks"]:
                product_key = trim(task.get("productId")) or f"{task.get('productName')}|{task.get('salesStatus')}"
                if product_key not in page_selected_product_keys:
                    continue
                material_url = trim(task.get("url"))
                if not material_url or material_url in seen_task_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append(task)
                page_task_count += 1
            page_meta = page_result["page"]
            page_meta["materialTaskCount"] = page_task_count
            pages.append(page_meta)
        if max_products and len(seen_product_keys) >= max_products:
            break

    records = crawl_cmrh_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_status: dict[str, str] = {trim(task.get("url")): trim(task.get("salesStatus")) for task in tasks}
    for record in records:
        status_key = task_page_by_status.get(trim(record.get("url")), "")
        if status_key:
            record_counts_by_page[status_key] = record_counts_by_page.get(status_key, 0) + 1
    for page in pages:
        sales_status = trim(page.get("salesStatus"))
        page["recordCount"] = record_counts_by_page.get(sales_status, 0) if page.get("pageNumber") == 1 else 0
    return {
        "ok": True,
        "company": company,
        "source": CMRH_LIFE_PRODUCT_INFO_URL,
        "officialDomain": "www.cmrh.com",
        "saleStatus": status_keys,
        "pageSize": page_size,
        "startPage": start_page,
        "endPage": end_page or None,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def aeon_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"available", "discontinued", "internet"}
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return {"available"}
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return {"discontinued"}
    if text in {"internet", "互联网", "互联网披露"}:
        return {"internet"}
    return {"available", "discontinued", "internet"}


def aeon_life_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name:
        return "健康险"
    if "医疗" in product_name or "护理" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    if "团体" in product_name:
        return "团体保险"
    return ""


def aeon_life_material_type(doc_type: str, label: str = "") -> str:
    if doc_type in {"R02", "R07"} or "说明" in label:
        return "product_manual"
    return "terms"


def aeon_life_material_label(doc_type: str) -> str:
    if doc_type == "R02":
        return "产品说明书"
    if doc_type == "R07":
        return "产品说明"
    return "产品条款"


def fetch_aeon_life_products(is_sale: str) -> tuple[int, list[dict[str, Any]]]:
    status, data = fetch_json(f"{AEON_LIFE_PRODUCT_LIST_ENDPOINT}?isSale={is_sale}")
    rows = data.get("list") if isinstance(data.get("list"), list) else []
    return status, rows


def aeon_life_download_url(product_name: str, doc: dict[str, Any]) -> str:
    query = urlencode(
        {
            "riskName": product_name,
            "docName": trim(doc.get("docName")),
            "docPath": trim(doc.get("docPath")),
            "docExt": trim(doc.get("docExt")) or ".pdf",
        },
        quote_via=quote,
    )
    return f"{AEON_LIFE_DOWNLOAD_ENDPOINT}?{query}"


def aeon_life_product_rows(company: str, status_key: str, rows: list[dict[str, Any]], max_products: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    sales_status = "在售" if status_key == "available" else "停售"
    source_page = f"{AEON_LIFE_PRODUCT_LIST_ENDPOINT}?isSale={'1' if status_key == 'available' else '0'}"
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_tasks: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        product_name = trim(row.get("riskName"))
        risk_code = trim(row.get("riskCode"))
        if not product_name:
            continue
        product_key = f"{status_key}|{risk_code}|{product_name}"
        if product_key in seen_products:
            continue
        if max_products and len(products) >= max_products:
            break
        seen_products.add(product_key)
        product_type = aeon_life_product_type(product_name)
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "sourcePage": source_page,
                "sourceStatus": status_key,
                "riskCode": risk_code,
                "riskLevel": trim(row.get("riskLevel")),
                "saleStartDate": trim(row.get("saleStartDate")),
                "saleEndDate": trim(row.get("saleEndDate")),
            }
        )
        try:
            docs = json.loads(trim(row.get("docJson")) or "[]")
        except Exception:
            docs = []
        for doc in docs if isinstance(docs, list) else []:
            if not isinstance(doc, dict):
                continue
            doc_type = trim(doc.get("docType"))
            if doc_type not in {"R01", "R02", "R07"}:
                continue
            doc_path = trim(doc.get("docPath"))
            if not doc_path:
                continue
            label = aeon_life_material_label(doc_type)
            material_url = aeon_life_download_url(product_name, doc)
            task_key = f"product_info|{doc_path}|{doc_type}|{product_name}"
            if task_key in seen_tasks:
                continue
            seen_tasks.add(task_key)
            tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "label": label,
                    "materialType": aeon_life_material_type(doc_type, label),
                    "url": material_url,
                    "sourcePage": source_page,
                    "riskCode": risk_code,
                    "docName": trim(doc.get("docName")),
                    "docType": doc_type,
                    "docPath": doc_path,
                }
            )
    return products, tasks


def parse_aeon_life_internet_disclosure(company: str) -> dict[str, Any]:
    status, html = fetch_html(AEON_LIFE_INTERNET_DISCLOSURE_URL)
    page = {
        "url": AEON_LIFE_INTERNET_DISCLOSURE_URL,
        "status": status,
        "saleStatus": "停售（互联网披露）",
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300:
        return {"page": page, "products": [], "tasks": []}
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = [html_text(str(cell)) for cell in row.find_all(["td", "th"])]
        if len(cells) < 4 or not re.fullmatch(r"\d+", trim(cells[0])):
            continue
        product_name = re.sub(r"（停售）$", "", trim(cells[1]).replace("\ufeff", ""))
        if not product_name:
            continue
        pdf_url = ""
        for anchor in row.find_all("a"):
            href = trim(anchor.get("href"))
            if ".pdf" not in href.lower():
                continue
            candidate = urljoin(AEON_LIFE_OFFICIAL_BASE_URL, href)
            hostname = urlsplit(candidate).netloc.lower()
            if hostname.endswith("aeonlife.com.cn"):
                pdf_url = candidate
                break
        if not pdf_url or pdf_url in seen_urls:
            continue
        seen_urls.add(pdf_url)
        product_type = aeon_life_product_type(product_name)
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": "停售（互联网披露）",
                "sourcePage": AEON_LIFE_INTERNET_DISCLOSURE_URL,
                "sourceStatus": "internet",
            }
        )
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": "停售（互联网披露）",
                "label": "产品条款",
                "materialType": "terms",
                "url": pdf_url,
                "sourcePage": AEON_LIFE_INTERNET_DISCLOSURE_URL,
            }
        )
    page["productCount"] = len(products)
    page["materialTaskCount"] = len(tasks)
    return {"page": page, "products": products, "tasks": tasks}


def crawl_aeon_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    hostname = urlsplit(material_url).netloc.lower()
    if not hostname.endswith("aeonlife.com.cn"):
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or AEON_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "产品条款"
    return {
        "company": trim(task.get("company")) or "百年人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or aeon_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"百年人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or aeon_life_material_type(trim(task.get("docType")), label),
        "official": True,
        "officialDomain": "aeonlife.com.cn",
        "parser": "scrapling_aeon_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_aeon_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_aeon_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_aeon_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_aeon_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "百年人寿"
    status_filter = aeon_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for status_key, is_sale, sale_status in [
        ("available", "1", "在售"),
        ("discontinued", "0", "停售"),
    ]:
        if status_key not in status_filter:
            continue
        status, rows = fetch_aeon_life_products(is_sale)
        page_meta = {
            "url": f"{AEON_LIFE_PRODUCT_LIST_ENDPOINT}?isSale={is_sale}",
            "sourcePage": AEON_LIFE_PRODUCT_INFO_URL,
            "status": status,
            "saleStatus": sale_status,
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            continue
        remaining = max(0, max_products - len(products)) if max_products else 0
        page_products, page_tasks = aeon_life_product_rows(company, status_key, rows, remaining)
        products.extend(page_products)
        for task in page_tasks:
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
        page_meta["productCount"] = len(page_products)
        page_meta["materialTaskCount"] = len(page_tasks)
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    if (not max_products or len(products) < max_products) and "internet" in status_filter:
        internet = parse_aeon_life_internet_disclosure(company)
        internet_products = internet["products"]
        if max_products:
            internet_products = internet_products[: max(0, max_products - len(products))]
        products.extend(internet_products)
        allowed_names = {trim(product.get("productName")) for product in internet_products}
        internet_task_count = 0
        for task in internet["tasks"]:
            if max_products and trim(task.get("productName")) not in allowed_names:
                continue
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
            internet_task_count += 1
        page_meta = internet["page"]
        page_meta["productCount"] = len(internet_products)
        page_meta["materialTaskCount"] = internet_task_count
        pages.append(page_meta)

    records = crawl_aeon_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("sourcePage")) or trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": AEON_LIFE_PRODUCT_INFO_URL,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def manulife_sinochem_page_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return set(MANULIFE_SINOCHEM_PRODUCT_PAGES.keys())
    if text in {"current", "product1", "最新", "当前"}:
        return {"current"}
    if text in {"legacy", "product", "历史", "旧版"}:
        return {"legacy"}
    return set(MANULIFE_SINOCHEM_PRODUCT_PAGES.keys())


def manulife_sinochem_sales_status(section_title: str) -> str:
    title = trim(section_title)
    if "停售" in title:
        return "停售"
    if "历史版本" in title or "已停用" in title:
        return "停售（在售产品历史版本已停用）"
    if "在售" in title:
        return "在售"
    return title or "未标明"


def manulife_sinochem_product_name(value: str) -> str:
    text = clean_text(value)
    text = re.split(r"备案编号|报备文件编号|条款编号", text, maxsplit=1)[0]
    text = re.sub(r"\s*[｛{][^｝}]+[｝}]\s*$", "", text)
    return trim(text)


def manulife_sinochem_product_type(product_name: str, category: str = "") -> str:
    name = trim(product_name)
    if "医疗" in name:
        return "医疗险"
    if "护理" in name or "重大疾病" in name or "疾病" in name or "恶性肿瘤" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    if "团体" in name:
        return "团体保险"
    return trim(category)


def manulife_sinochem_material_type(label: str) -> str:
    if "说明" in trim(label):
        return "product_manual"
    return "terms"


def manulife_sinochem_responsibility_excerpt(text: str) -> str:
    normalized = clean_text(text)
    if not normalized:
        return ""
    candidates = []
    for match in re.finditer(r"保险责任", normalized):
        start = match.start()
        before = normalized[max(0, start - 160) : start]
        after = normalized[start : start + 700]
        if re.match(r"保险责任[。，；;]", after):
            continue
        if "条款中列明" in after[:60] or "请您注意" in after[:100]:
            continue
        if re.search(r"目\s*录|条款目录", before[-200:]) or "阅读指引" in before[-120:]:
            continue
        if (
            re.match(r"保险责任\s*(?:在本合同|在本附加合同|本合同|本附加合同|若|自|我们将|被保险人)", after)
            or ("第二部分" in before and re.search(r"在本(?:附加)?合同(?:的)?(?:有效期|保险期间)内", after))
        ):
            candidates.append(start)
    if not candidates:
        return ""
    start = candidates[0]
    tail = normalized[start:]
    end_match = RESPONSIBILITY_END_RE.search(tail[40:])
    excerpt = tail[: 40 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
    sentences = re.split(r"(?<=[。；;])", excerpt)
    kept = []
    for sentence in sentences:
        item = sentence.strip()
        if not item:
            continue
        if any(keyword in item for keyword in RESPONSIBILITY_KEYWORDS):
            kept.append(item)
    output = "\n".join(kept).strip()
    return output[:MAX_EXCERPT_CHARS] if output else excerpt[:MAX_EXCERPT_CHARS]


def manulife_sinochem_keep_material(label: str, material_url: str) -> bool:
    text = trim(label)
    if text not in RESPONSIBILITY_MATERIAL_LABELS:
        return False
    if EXCLUDED_MATERIAL_RE.search(f"{text} {material_url}"):
        return False
    parts = urlsplit(material_url)
    hostname = parts.netloc.lower()
    return parts.scheme in {"http", "https"} and hostname.endswith(MANULIFE_SINOCHEM_OFFICIAL_DOMAIN) and parts.path.lower().endswith(".pdf")


def manulife_sinochem_parse_products(company: str, page_key: str, html: str) -> list[dict[str, Any]]:
    page = MANULIFE_SINOCHEM_PRODUCT_PAGES[page_key]
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for section in soup.select(".faq-container-list"):
        title_node = section.select_one(".faq-subtitle")
        section_title = html_text(str(title_node)) if title_node else ""
        sales_status = manulife_sinochem_sales_status(section_title)
        for item in section.select(".item"):
            product_node = item.select_one(".item-left")
            product_name = manulife_sinochem_product_name(product_node.get_text(" ", strip=True) if product_node else "")
            if not product_name:
                continue
            product_category = ""
            text_parts = [clean_text(node.get_text(" ", strip=True)) for node in item.select(".item-right span")]
            for index, part in enumerate(text_parts):
                if "产品分类" in part and index + 1 < len(text_parts):
                    product_category = trim(text_parts[index + 1])
                    break
            materials: list[dict[str, str]] = []
            for anchor in item.select("a"):
                label = html_text(str(anchor))
                href = trim(anchor.get("href"))
                if not label or not href:
                    continue
                material_url = urljoin(page["url"], href)
                if not manulife_sinochem_keep_material(label, material_url):
                    continue
                if material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                materials.append(
                    {
                        "label": label,
                        "type": manulife_sinochem_material_type(label),
                        "url": material_url,
                    }
                )
            if not materials:
                continue
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": manulife_sinochem_product_type(product_name, product_category),
                    "productCategory": product_category,
                    "salesStatus": sales_status,
                    "sourcePage": page["url"],
                    "sourceStatus": page_key,
                    "sectionTitle": section_title,
                    "materials": materials,
                }
            )
    return products


def crawl_manulife_sinochem_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or MANULIFE_SINOCHEM_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = manulife_sinochem_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "中宏人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"中宏人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or manulife_sinochem_material_type(label),
        "official": True,
        "officialDomain": MANULIFE_SINOCHEM_OFFICIAL_DOMAIN,
        "parser": "scrapling_manulife_sinochem_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_manulife_sinochem_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_manulife_sinochem_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_manulife_sinochem_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_manulife_sinochem_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中宏人寿"
    page_keys = manulife_sinochem_page_filter(trim(payload.get("page") or payload.get("sourcePage")))
    sale_filter = trim(payload.get("saleStatus") or payload.get("status")).lower()
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()

    for page_key in ("current", "legacy"):
        if page_key not in page_keys:
            continue
        page = MANULIFE_SINOCHEM_PRODUCT_PAGES[page_key]
        status, html = fetch_html_direct(page["url"], referer=MANULIFE_SINOCHEM_OFFICIAL_BASE_URL)
        page_meta = {
            "url": page["url"],
            "status": status,
            "label": page["label"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300 or not html:
            pages.append(page_meta)
            continue
        page_products = manulife_sinochem_parse_products(company, page_key, html)
        for product in page_products:
            sales_status = trim(product.get("salesStatus"))
            if sale_filter in {"in_sale", "sale", "available", "在售", "y"} and sales_status != "在售":
                continue
            if sale_filter in {"stopped", "stop", "discontinued", "停售", "n"} and not sales_status.startswith("停售"):
                continue
            if max_products and len(products) >= max_products:
                break
            products.append({key: value for key, value in product.items() if key != "materials"})
            for material in product.get("materials", []):
                material_url = trim(material.get("url"))
                if not material_url or material_url in seen_task_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product["productName"],
                        "productType": product["productType"],
                        "salesStatus": product["salesStatus"],
                        "label": material["label"],
                        "materialType": material["type"],
                        "url": material_url,
                        "sourcePage": product["sourcePage"],
                    }
                )
        page_meta["productCount"] = len([product for product in products if product.get("sourceStatus") == page_key])
        page_meta["materialTaskCount"] = len([task for task in tasks if task.get("sourcePage") == page["url"]])
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    records = crawl_manulife_sinochem_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page_meta in pages:
        page_meta["recordCount"] = record_counts_by_page.get(page_meta["url"], 0)
    return {
        "ok": True,
        "company": company,
        "source": ", ".join(page["url"] for key, page in MANULIFE_SINOCHEM_PRODUCT_PAGES.items() if key in page_keys),
        "saleStatus": sale_filter or "all",
        "page": ",".join(sorted(page_keys)),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def sunlife_everbright_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    if text in {"available", "in_sale", "sale", "在售", "y", "1"}:
        return {"在售"}
    if text in {"discontinued", "stopped", "stop", "停售", "n", "0"}:
        return {"停售"}
    return {value}


def sunlife_everbright_product_type(product_name: str) -> str:
    if "团体" in product_name:
        return "团体保险"
    if any(keyword in product_name for keyword in ("重大疾病", "疾病", "医疗", "护理", "癌症", "防癌", "健康")):
        return "健康保险"
    if any(keyword in product_name for keyword in ("意外", "交通", "旅行", "驾乘")):
        return "意外保险"
    if any(keyword in product_name for keyword in ("年金", "养老")):
        return "年金保险"
    if any(keyword in product_name for keyword in ("两全", "终身寿险", "定期寿险", "寿险")):
        return "人寿保险"
    return ""


def sunlife_everbright_normalize_material_url(href: str, source_page: str = SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL) -> str:
    value = html_lib.unescape(trim(href))
    if not value:
        return ""
    full_url = urljoin(source_page or SUNLIFE_EVERBRIGHT_OFFICIAL_BASE_URL, value)
    parts = urlsplit(full_url)
    path = parts.path
    if parts.hostname and parts.hostname.startswith("10.") and path.startswith(("/sleb/", "/Portals/")):
        return urlunsplit(("https", SUNLIFE_EVERBRIGHT_OFFICIAL_DOMAIN, path, parts.query, ""))
    hostname = (parts.hostname or "").lower()
    if not hostname.endswith("sunlife-everbright.com"):
        return ""
    return urlunsplit((parts.scheme or "https", parts.netloc or SUNLIFE_EVERBRIGHT_OFFICIAL_DOMAIN, path, parts.query, ""))


def sunlife_everbright_decode_zip_filename(filename: str) -> str:
    value = filename or ""
    try:
        decoded = value.encode("cp437").decode("gbk")
    except Exception:
        return value
    if any(keyword in decoded for keyword in ("光大永明", "保险", "条款", "产品说明书", "费率表")):
        return decoded
    return value


def sunlife_everbright_zip_entry_basename(filename: str) -> str:
    return re.split(r"[/\\]+", sunlife_everbright_decode_zip_filename(filename))[-1]


def sunlife_everbright_archive_material_from_filename(filename: str, fallback_type: str = "") -> dict[str, str] | None:
    value = trim(sunlife_everbright_decode_zip_filename(filename))
    basename = sunlife_everbright_zip_entry_basename(value)
    lower = basename.lower()
    if not lower.endswith(".pdf"):
        return None
    if SUNLIFE_EVERBRIGHT_ARCHIVE_EXCLUDED_RE.search(basename):
        return None
    title = re.sub(r"\.pdf$", "", basename, flags=re.I)
    if "产品说明书" in basename or "产品说明" in basename:
        return {"label": "产品说明书", "materialType": "product_manual", "title": title}
    if "保险条款" in basename or "利益条款" in basename or "条款" in basename:
        return {"label": "保险条款", "materialType": "terms", "title": title}
    if fallback_type == "terms":
        return {"label": "保险条款", "materialType": "terms", "title": title}
    if fallback_type == "product_manual":
        return {"label": "产品说明书", "materialType": "product_manual", "title": title}
    return None


def sunlife_everbright_record_from_pdf(
    task: dict[str, str],
    material_url: str,
    data: bytes,
    source_type: str = "pdf",
    entry_name: str = "",
    archive_material: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim((archive_material or {}).get("label")) or trim(task.get("label")) or "保险条款"
    material_type_value = trim((archive_material or {}).get("materialType")) or trim(task.get("materialType")) or "terms"
    title = trim((archive_material or {}).get("title")) or trim(task.get("title")) or f"{product_name}{label}"
    return {
        "company": trim(task.get("company")) or "光大永明人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or sunlife_everbright_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": title,
        "url": material_url,
        "snippet": f"光大永明人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": source_type,
        "materialType": material_type_value,
        "official": True,
        "officialDomain": SUNLIFE_EVERBRIGHT_OFFICIAL_DOMAIN,
        "parser": "scrapling_sunlife_everbright_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "archiveEntry": entry_name,
    }


def sunlife_everbright_records_from_zip(task: dict[str, str], data: bytes) -> list[dict[str, Any]]:
    if len(data) > MAX_ZIP_BYTES or not data.startswith(b"PK"):
        return []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), metadata_encoding="gbk")
    except TypeError:
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except Exception:
            return []
    except Exception:
        return []
    records: list[dict[str, Any]] = []
    archive_url = trim(task.get("url"))
    for info in archive.infolist():
        entry_name = sunlife_everbright_decode_zip_filename(info.filename)
        material = sunlife_everbright_archive_material_from_filename(entry_name, trim(task.get("fallbackMaterialType")))
        if not material or info.file_size <= 0 or info.file_size > MAX_PDF_BYTES:
            continue
        try:
            pdf_bytes = archive.read(info)
        except Exception:
            continue
        if len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF"):
            continue
        material_url = f"{archive_url}#entry={quote(entry_name, safe='')}"
        record = sunlife_everbright_record_from_pdf(task, material_url, pdf_bytes, "archive_pdf", entry_name, material)
        if record:
            records.append(record)
    return records


def crawl_sunlife_everbright_material_task_records(task: dict[str, str]) -> list[dict[str, Any]]:
    material_url = trim(task.get("url"))
    if not material_url:
        return []
    hostname = (urlsplit(material_url).hostname or "").lower()
    if not hostname.endswith("sunlife-everbright.com"):
        return []
    referer = trim(task.get("sourcePage")) or SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL
    lower_path = urlsplit(material_url).path.lower()
    if lower_path.endswith(".zip"):
        status, data = fetch_bytes_direct_limited(material_url, referer=referer, max_bytes=MAX_ZIP_BYTES, max_time=90)
        if status < 200 or status >= 300 or len(data) > MAX_ZIP_BYTES:
            return []
        return sunlife_everbright_records_from_zip(task, data)
    pdf_status, data = fetch_bytes_direct(material_url, referer=referer)
    if pdf_status < 200 or pdf_status >= 300:
        return []
    record = sunlife_everbright_record_from_pdf(task, material_url, data, "pdf")
    return [record] if record else []


def crawl_sunlife_everbright_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_sunlife_everbright_material_task_records(task))
        return records
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_sunlife_everbright_material_task_records, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return records


def sunlife_everbright_parse_table(company: str, table: Any, sales_status: str, source_page: str) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 3:
            continue
        sequence = trim(cells[0].get_text(" ", strip=True))
        if not sequence.isdigit():
            continue
        product_name = trim(cells[1].get_text(" ", strip=True))
        if not product_name:
            continue
        product_type = sunlife_everbright_product_type(product_name)
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "sourcePage": source_page,
                "sequence": sequence,
            }
        )
        for index, cell in enumerate(cells[2:], start=2):
            fallback_type = "terms" if (sales_status == "停售" or index == 2) else ""
            label = "产品条款" if fallback_type == "terms" else "其他信息"
            for anchor in cell.find_all("a"):
                material_url = sunlife_everbright_normalize_material_url(trim(anchor.get("href")), source_page)
                if not material_url:
                    continue
                path = urlsplit(material_url).path.lower()
                if not path.endswith((".pdf", ".zip")):
                    continue
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": sales_status,
                        "label": label,
                        "materialType": "terms" if path.endswith(".pdf") and fallback_type == "terms" else ("archive" if path.endswith(".zip") else ""),
                        "fallbackMaterialType": fallback_type,
                        "url": material_url,
                        "sourcePage": source_page,
                    }
                )
    return products, tasks


def crawl_sunlife_everbright_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "光大永明人寿"
    status_filter = sunlife_everbright_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    product_offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, html = fetch_html_direct(SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL, referer=SUNLIFE_EVERBRIGHT_OFFICIAL_BASE_URL)
    if status < 200 or status >= 300 or "审批或者备案的保险产品目录" not in html:
        try:
            status, html = fetch_html(SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL)
        except Exception:
            status, html = 0, ""
    pages = [
        {
            "url": SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL,
            "status": status,
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
    ]
    if status < 200 or status >= 300 or "审批或者备案的保险产品目录" not in html:
        return {
            "ok": False,
            "company": company,
            "source": SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL,
            "pages": pages,
            "products": [],
            "materialTaskCount": 0,
            "records": [],
        }
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for table in soup.find_all("table"):
        text = trim(table.get_text(" ", strip=True))
        sales_status = ""
        if "在售产品名称" in text:
            sales_status = "在售"
        elif "停售产品名称" in text:
            sales_status = "停售"
        if not sales_status or sales_status not in status_filter:
            continue
        page_products, page_tasks = sunlife_everbright_parse_table(company, table, sales_status, SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL)
        products.extend(page_products)
        tasks.extend(page_tasks)

    if product_offset or max_products:
        selected_products = products[product_offset : product_offset + max_products] if max_products else products[product_offset:]
        allowed_names = {product["productName"] for product in selected_products}
        products = selected_products
        tasks = [task for task in tasks if task.get("productName") in allowed_names]

    seen_urls: set[str] = set()
    unique_tasks: list[dict[str, str]] = []
    for task in tasks:
        material_url = trim(task.get("url"))
        key = f"{trim(task.get('productName'))}|{trim(task.get('materialType'))}|{material_url}"
        if not material_url or key in seen_urls:
            continue
        seen_urls.add(key)
        unique_tasks.append(task)
    tasks = unique_tasks

    records = crawl_sunlife_everbright_material_records(tasks, max_workers=max_workers)
    pages[0]["productCount"] = len(products)
    pages[0]["materialTaskCount"] = len(tasks)
    pages[0]["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL,
        "officialDomain": SUNLIFE_EVERBRIGHT_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "offset": product_offset,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def aegon_thtf_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售", "已报备未销售"}
    if text in {"in_sale", "sale", "available", "在售", "y", "1"}:
        return {"在售"}
    if text in {"stopped", "stop", "discontinued", "停售", "n", "0"}:
        return {"停售"}
    if text in {"reported", "not_sold", "unsold", "已报备未销售", "未销售"}:
        return {"已报备未销售"}
    return {"在售", "停售", "已报备未销售"}


def aegon_thtf_page_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return set(AEGON_THTF_PRODUCT_LISTS.keys())
    if text in AEGON_THTF_PRODUCT_LISTS:
        return {text}
    if text in {"personal", "individual", "个人", "个险"}:
        return {"listArr1", "listArr3"}
    if text in {"group", "团体", "团险"}:
        return {"listArr2", "listArr4"}
    if text in {"current", "available", "在售"}:
        return {"listArr1", "listArr2"}
    if text in {"stopped", "discontinued", "停售"}:
        return {"listArr3", "listArr4"}
    if text in {"reported", "not_sold", "unsold", "已报备未销售", "未销售"}:
        return {"listArr6"}
    return set(AEGON_THTF_PRODUCT_LISTS.keys())


def aegon_thtf_product_type(product_name: str, segment: str = "") -> str:
    name = trim(product_name)
    if "医疗" in name:
        return "医疗险"
    if "护理" in name or "重大疾病" in name or "疾病" in name or "恶性肿瘤" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    if "团体" in name or trim(segment) == "团体保险":
        return "团体保险"
    return trim(segment)


def aegon_thtf_js_html(value: str) -> str:
    text = value or ""
    text = text.replace("\\/", "/").replace("\\'", "'").replace('\\"', '"')
    return html_lib.unescape(text)


def aegon_thtf_material_from_filename(filename: str) -> dict[str, str] | None:
    value = trim(filename)
    basename = re.split(r"[/\\]+", value)[-1]
    lower = basename.lower()
    if not lower.endswith(".pdf"):
        return None
    excluded = r"费率|保险费率|现金价值|全表|账户价值|利益演示|停售|公告|通知|批复|回执|材料清单|清单|报送|备案材料|投保规则|投保须知|告知书|职业分类"
    if re.search(excluded, basename, re.I):
        return None
    if "产品说明书" in basename or "产品说明" in basename:
        return {"label": "产品说明书", "materialType": "product_manual", "basename": basename}
    if "保险条款" in basename or "利益条款" in basename or "条款" in basename:
        return {"label": "保险条款", "materialType": "terms", "basename": basename}
    return None


def aegon_thtf_keep_archive_url(url: str) -> bool:
    parts = urlsplit(url)
    hostname = parts.netloc.lower()
    path = parts.path.lower()
    return (
        parts.scheme in {"http", "https"}
        and (hostname.endswith(AEGON_THTF_ATTACHMENT_DOMAIN) or hostname.endswith(AEGON_THTF_OFFICIAL_DOMAIN))
        and path.endswith((".zip", ".rar"))
    )


def fetch_bytes_direct_limited(url: str, referer: str = "", max_bytes: int = MAX_PDF_BYTES, max_time: int = 70) -> tuple[int, bytes]:
    marker = b"\n__POLICY_CURL_HTTP_STATUS__:"
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "--max-time",
            str(max_time),
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {referer or AEGON_THTF_OFFICIAL_BASE_URL}",
            "-w",
            "\n__POLICY_CURL_HTTP_STATUS__:%{http_code}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=max_time + 15,
    )
    if proc.returncode != 0:
        return 0, b""
    output = proc.stdout or b""
    status = 200
    marker_index = output.rfind(marker)
    if marker_index >= 0:
        status_text = output[marker_index + len(marker) :].strip()[:3]
        try:
            status = int(status_text)
        except Exception:
            status = 0
        output = output[:marker_index]
    return status, output[: max_bytes + 1]


def aegon_thtf_fetch_archive(url: str, referer: str = "") -> tuple[int, bytes]:
    return fetch_bytes_direct_limited(
        url,
        referer=referer or AEGON_THTF_PRODUCT_INFO_URL,
        max_bytes=MAX_ZIP_BYTES,
        max_time=90,
    )


def aegon_thtf_archive_suffix(url: str, data: bytes) -> str:
    path = urlsplit(url).path.lower()
    if path.endswith(".zip") or data.startswith(b"PK"):
        return ".zip"
    if path.endswith(".rar") or data.startswith(b"Rar!"):
        return ".rar"
    return ".archive"


def aegon_thtf_records_from_archive(task: dict[str, str], data: bytes) -> list[dict[str, Any]]:
    if len(data) > MAX_ZIP_BYTES:
        return []
    archive_url = trim(task.get("url"))
    suffix = aegon_thtf_archive_suffix(archive_url, data)
    if suffix not in {".zip", ".rar"}:
        return []
    records: list[dict[str, Any]] = []
    bsdtar = os.environ.get("BSDTAR_BIN") or "/usr/bin/bsdtar"
    with tempfile.TemporaryDirectory(prefix="aegon-thtf-") as temp_dir:
        archive_path = os.path.join(temp_dir, f"material{suffix}")
        extract_dir = os.path.join(temp_dir, "extract")
        os.makedirs(extract_dir, exist_ok=True)
        with open(archive_path, "wb") as handle:
            handle.write(data)
        try:
            proc = subprocess.run(
                [bsdtar, "-xf", archive_path, "-C", extract_dir],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=45,
            )
        except Exception:
            return []
        if proc.returncode != 0:
            return []
        extract_root = os.path.abspath(extract_dir)
        for root, _, files in os.walk(extract_dir):
            for filename in files:
                file_path = os.path.abspath(os.path.join(root, filename))
                if not file_path.startswith(extract_root + os.sep):
                    continue
                rel_path = os.path.relpath(file_path, extract_dir)
                material = aegon_thtf_material_from_filename(rel_path)
                if not material:
                    continue
                try:
                    size = os.path.getsize(file_path)
                except Exception:
                    continue
                if size <= 0 or size > MAX_PDF_BYTES:
                    continue
                try:
                    with open(file_path, "rb") as pdf_file:
                        pdf_bytes = pdf_file.read(MAX_PDF_BYTES + 1)
                except Exception:
                    continue
                if len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF"):
                    continue
                extracted = extract_pdf_text_with_system_python(pdf_bytes)
                page_text = focused_responsibility_excerpt(extracted.get("text", ""))
                if not page_text or "保险责任" not in page_text:
                    continue
                product_name = trim(task.get("productName"))
                label = material["label"]
                basename = material["basename"]
                records.append(
                    {
                        "company": trim(task.get("company")) or "同方全球人寿",
                        "productName": product_name,
                        "productType": trim(task.get("productType")),
                        "salesStatus": trim(task.get("salesStatus")),
                        "title": re.sub(r"\.pdf$", "", basename, flags=re.I),
                        "url": f"{archive_url}#entry={quote(rel_path, safe='')}",
                        "snippet": f"同方全球官网产品备案材料包内{label}，已截取保险责任正文段。",
                        "pageText": page_text,
                        "sourceType": "archive_pdf",
                        "materialType": material["materialType"],
                        "official": True,
                        "officialDomain": AEGON_THTF_ATTACHMENT_DOMAIN,
                        "parser": "scrapling_aegon_thtf_product_info",
                        "pages": extracted.get("pages", 0),
                        "bytes": len(pdf_bytes),
                        "archiveUrl": archive_url,
                        "sourcePage": trim(task.get("sourcePage")),
                        "sourceList": trim(task.get("sourceList")),
                        "segment": trim(task.get("segment")),
                    }
                )
    return records


def crawl_aegon_thtf_archive_records(task: dict[str, str]) -> list[dict[str, Any]]:
    archive_url = trim(task.get("url"))
    if not aegon_thtf_keep_archive_url(archive_url):
        return []
    status, data = aegon_thtf_fetch_archive(archive_url, referer=trim(task.get("sourcePage")) or AEGON_THTF_PRODUCT_INFO_URL)
    if status < 200 or status >= 300 or len(data) > MAX_ZIP_BYTES:
        return []
    return aegon_thtf_records_from_archive(task, data)


def crawl_aegon_thtf_archive_records_batch(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_aegon_thtf_archive_records(task))
        return sorted(records, key=lambda record: trim(record.get("url")))
    records = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_aegon_thtf_archive_records, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return sorted(records, key=lambda record: trim(record.get("url")))


def aegon_thtf_parse_list(company: str, list_key: str, html: str) -> list[dict[str, Any]]:
    profile = AEGON_THTF_PRODUCT_LISTS[list_key]
    match = re.search(rf"var\s+{re.escape(list_key)}\s*=\s*\[(.*?)\];", html or "", re.S)
    if not match:
        return []
    products: list[dict[str, Any]] = []
    seen_archives: set[str] = set()
    for _, ele_name in re.findall(r"\{'eleId':'([^']*)','eleName':'(.*?)'\}", match.group(1), re.S):
        soup = BeautifulSoup(aegon_thtf_js_html(ele_name), "html.parser")
        for row in soup.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            product_name = clean_text(cells[0].get_text(" ", strip=True))
            if not product_name:
                continue
            archive_link = None
            for anchor in row.find_all("a"):
                href = trim(anchor.get("href"))
                material_url = urljoin(AEGON_THTF_PRODUCT_INFO_URL, href)
                if aegon_thtf_keep_archive_url(material_url):
                    archive_link = {
                        "label": clean_text(anchor.get_text(" ", strip=True)) or "产品备案材料",
                        "url": material_url,
                    }
                    break
            if not archive_link or archive_link["url"] in seen_archives:
                continue
            seen_archives.add(archive_link["url"])
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": aegon_thtf_product_type(product_name, profile["segment"]),
                    "salesStatus": profile["salesStatus"],
                    "segment": profile["segment"],
                    "sourcePage": AEGON_THTF_PRODUCT_INFO_URL,
                    "sourceList": list_key,
                    "sourceLabel": profile["label"],
                    "archiveLabel": archive_link["label"],
                    "archiveUrl": archive_link["url"],
                }
            )
    return products


def crawl_aegon_thtf_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "同方全球人寿"
    status_filter = aegon_thtf_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    page_filter = aegon_thtf_page_filter(trim(payload.get("page") or payload.get("sourcePage")))
    offset = max(0, int(payload.get("offset") or payload.get("startOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, html = fetch_html_direct(AEGON_THTF_PRODUCT_INFO_URL, referer=AEGON_THTF_OFFICIAL_BASE_URL)
    if status < 200 or status >= 300 or not html:
        try:
            status, html = fetch_html(AEGON_THTF_PRODUCT_INFO_URL)
        except Exception:
            pass
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    skipped_products = 0
    total_candidate_products = 0

    for list_key, profile in AEGON_THTF_PRODUCT_LISTS.items():
        if list_key not in page_filter or profile["salesStatus"] not in status_filter:
            continue
        page_products = aegon_thtf_parse_list(company, list_key, html)
        total_candidate_products += len(page_products)
        for product in page_products:
            if skipped_products < offset:
                skipped_products += 1
                continue
            if max_products and len(products) >= max_products:
                break
            products.append({key: value for key, value in product.items() if key != "archiveUrl"})
            tasks.append(
                {
                    "company": company,
                    "productName": product["productName"],
                    "productType": product["productType"],
                    "salesStatus": product["salesStatus"],
                    "segment": product["segment"],
                    "label": product["archiveLabel"],
                    "url": product["archiveUrl"],
                    "sourcePage": product["sourcePage"],
                    "sourceList": product["sourceList"],
                }
            )
        pages.append(
            {
                "url": AEGON_THTF_PRODUCT_INFO_URL,
                "status": status,
                "sourceList": list_key,
                "label": profile["label"],
                "salesStatus": profile["salesStatus"],
                "segment": profile["segment"],
                "productCount": len([product for product in products if product.get("sourceList") == list_key]),
                "materialTaskCount": len([task for task in tasks if task.get("sourceList") == list_key]),
                "recordCount": 0,
            }
        )
        if max_products and len(products) >= max_products:
            break

    records = crawl_aegon_thtf_archive_records_batch(tasks, max_workers=max_workers)
    archive_list_by_url = {trim(task.get("url")): trim(task.get("sourceList")) for task in tasks}
    record_counts_by_list: dict[str, int] = {}
    for record in records:
        archive_url = trim(record.get("archiveUrl")) or trim(record.get("url")).split("#", 1)[0]
        source_list = archive_list_by_url.get(archive_url)
        if source_list:
            record_counts_by_list[source_list] = record_counts_by_list.get(source_list, 0) + 1
    for page_meta in pages:
        page_meta["recordCount"] = record_counts_by_list.get(trim(page_meta.get("sourceList")), 0)

    return {
        "ok": True,
        "company": company,
        "source": AEGON_THTF_PRODUCT_INFO_URL,
        "officialDomain": AEGON_THTF_OFFICIAL_DOMAIN,
        "attachmentDomain": AEGON_THTF_ATTACHMENT_DOMAIN,
        "saleStatus": sorted(status_filter),
        "page": sorted(page_filter),
        "offset": offset,
        "maxProducts": max_products,
        "totalCandidateProductCount": total_candidate_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def generali_china_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    if text in {"in_sale", "sale", "available", "在售", "y", "1"}:
        return {"在售"}
    if text in {"stopped", "stop", "discontinued", "停售", "n", "0"}:
        return {"停售"}
    return {"在售", "停售"}


def generali_china_life_segment_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"个人保险", "团体保险"}
    if text in {"personal", "individual", "个人", "个险"}:
        return {"个人保险"}
    if text in {"group", "团体", "团险"}:
        return {"团体保险"}
    return {"个人保险", "团体保险"}


def fetch_generali_china_life_html(url: str) -> tuple[int, str]:
    status, html = fetch_html_direct(url, referer=GENERALI_CHINA_LIFE_OFFICIAL_BASE_URL)
    if status >= 200 and status < 300 and html:
        return status, html
    try:
        return fetch_html(url)
    except Exception:
        return status, html


def generali_china_life_page_url(base_url: str, page_number: int) -> str:
    if page_number <= 1:
        return base_url
    return urljoin(base_url, f"index_{page_number}.html")


def extract_generali_china_life_total_pages(html: str) -> int:
    pages = [1]
    for match in re.finditer(r"index_(\d+)\.html", html or ""):
        pages.append(int(match.group(1)))
    return max(pages)


def generali_china_life_product_type(product_name: str, segment: str) -> str:
    product_type = taikang_life_product_type(product_name)
    if product_type:
        return product_type
    if "团体" in product_name or trim(segment) == "团体保险":
        return "团体保险"
    return ""


def generali_china_life_material_type(label: str, title: str = "") -> str:
    text = f"{label} {title}"
    if "产品说明" in text or "说明书" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def generali_china_life_material_label(label: str, title: str = "") -> str:
    material = generali_china_life_material_type(label, title)
    if material == "product_manual":
        return "产品说明书"
    if material == "terms":
        return "条款"
    return trim(label)


def generali_china_life_material_field(text: str, name: str) -> str:
    match = re.search(rf"{re.escape(name)}：\s*([^\s]+)", text or "")
    return trim(match.group(1)) if match else ""


def generali_china_life_sales_status(base_status: str, stop_date: str) -> str:
    if trim(base_status) == "停售" and stop_date and stop_date != "暂未停用":
        return f"停售（{stop_date}）"
    return trim(base_status) or "未标明"


def generali_china_life_keep_material(label: str, title: str, material_url: str) -> bool:
    if not generali_china_life_material_type(label, title):
        return False
    if EXCLUDED_MATERIAL_RE.search(f"{label} {title} {material_url}"):
        return False
    parts = urlsplit(material_url)
    hostname = parts.netloc.lower()
    return (
        parts.scheme in {"http", "https"}
        and hostname.endswith("generalichina.com")
        and parts.path.lower().endswith(".pdf")
    )


def extract_generali_china_life_listing_page(profile: dict[str, str], page_number: int) -> dict[str, Any]:
    page_url = generali_china_life_page_url(profile["url"], page_number)
    status, html = fetch_generali_china_life_html(page_url)
    page_meta = {
        "url": page_url,
        "status": status,
        "sourceKey": profile["key"],
        "segment": profile["segment"],
        "salesStatus": profile["salesStatus"],
        "pageNumber": page_number,
        "totalPages": extract_generali_china_life_total_pages(html),
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return {"page": page_meta, "products": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, str]] = []
    for anchor in soup.select("a.main_content_title"):
        product_name = clean_text(anchor.get_text(" ", strip=True))
        href = trim(anchor.get("href"))
        detail_url = urljoin(page_url, href)
        if not product_name or not href:
            continue
        products.append(
            {
                "company": "中意人寿",
                "productName": product_name,
                "productType": generali_china_life_product_type(product_name, profile["segment"]),
                "salesStatus": profile["salesStatus"],
                "segment": profile["segment"],
                "sourcePage": page_url,
                "sourceKey": profile["key"],
                "detailUrl": detail_url,
            }
        )
    page_meta["productCount"] = len(products)
    return {"page": page_meta, "products": products}


def extract_generali_china_life_detail_tasks(product: dict[str, str]) -> dict[str, Any]:
    detail_url = trim(product.get("detailUrl"))
    status, html = fetch_generali_china_life_html(detail_url)
    if status < 200 or status >= 300 or not html:
        return {"url": detail_url, "status": status, "tasks": []}
    soup = BeautifulSoup(html, "html.parser")
    tasks: list[dict[str, str]] = []
    for section in soup.select(".press_list"):
        label_node = section.select_one(".problem_list_ask span")
        label = clean_text(label_node.get_text(" ", strip=True) if label_node else "")
        for anchor in section.select(".regulations_list_name a"):
            title = clean_text(anchor.get_text(" ", strip=True))
            href = trim(anchor.get("href"))
            material_url = urljoin(detail_url, href)
            if not generali_china_life_keep_material(label, title, material_url):
                continue
            parent = anchor.find_parent("div", class_="regulations_list_name")
            parent_text = clean_text(parent.get_text(" ", strip=True) if parent else "")
            stop_date = generali_china_life_material_field(parent_text, "停用时间")
            tasks.append(
                {
                    "company": trim(product.get("company")) or "中意人寿",
                    "productName": trim(product.get("productName")),
                    "productType": trim(product.get("productType")),
                    "salesStatus": generali_china_life_sales_status(trim(product.get("salesStatus")), stop_date),
                    "segment": trim(product.get("segment")),
                    "label": label,
                    "materialType": generali_china_life_material_type(label, title),
                    "title": title,
                    "url": material_url,
                    "sourcePage": trim(product.get("sourcePage")),
                    "detailUrl": detail_url,
                    "enabledAt": generali_china_life_material_field(parent_text, "启用时间"),
                    "stoppedAt": stop_date,
                    "disclosedAt": generali_china_life_material_field(parent_text, "披露时间"),
                }
            )
    seen_urls = {trim(task.get("url")) for task in tasks}
    for block in soup.select(".regulations_list_name"):
        if block.find_parent(class_="press_list"):
            continue
        for anchor in block.select("a"):
            title = clean_text(anchor.get_text(" ", strip=True))
            href = trim(anchor.get("href") or anchor.get("Boff"))
            material_url = urljoin(detail_url, href)
            label = generali_china_life_material_label("", title)
            if material_url in seen_urls or not generali_china_life_keep_material(label, title, material_url):
                continue
            seen_urls.add(material_url)
            parent_text = clean_text(block.get_text(" ", strip=True))
            stop_date = generali_china_life_material_field(parent_text, "停用时间")
            tasks.append(
                {
                    "company": trim(product.get("company")) or "中意人寿",
                    "productName": trim(product.get("productName")),
                    "productType": trim(product.get("productType")),
                    "salesStatus": generali_china_life_sales_status(trim(product.get("salesStatus")), stop_date),
                    "segment": trim(product.get("segment")),
                    "label": label,
                    "materialType": generali_china_life_material_type(label, title),
                    "title": title,
                    "url": material_url,
                    "sourcePage": trim(product.get("sourcePage")),
                    "detailUrl": detail_url,
                    "enabledAt": generali_china_life_material_field(parent_text, "启用时间"),
                    "stoppedAt": stop_date,
                    "disclosedAt": generali_china_life_material_field(parent_text, "披露时间"),
                }
            )
    return {"url": detail_url, "status": status, "tasks": tasks}


def crawl_generali_china_life_detail_tasks(products: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not products:
        return []
    if max_workers <= 1:
        return [extract_generali_china_life_detail_tasks(product) for product in products]
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(extract_generali_china_life_detail_tasks, product) for product in products]
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as error:
                results.append({"url": "", "status": 0, "error": str(error), "tasks": []})
    return results


def crawl_generali_china_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("detailUrl")) or GENERALI_CHINA_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "中意人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": trim(task.get("title")) or f"{product_name}{label}",
        "url": material_url,
        "snippet": f"中意人寿官网{trim(task.get('segment'))}{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or generali_china_life_material_type(label),
        "official": True,
        "officialDomain": GENERALI_CHINA_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_generali_china_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "enabledAt": trim(task.get("enabledAt")),
        "stoppedAt": trim(task.get("stoppedAt")),
        "disclosedAt": trim(task.get("disclosedAt")),
    }


def crawl_generali_china_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_generali_china_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_generali_china_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_generali_china_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中意人寿"
    status_filter = generali_china_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    segment_filter = generali_china_life_segment_filter(trim(payload.get("segment") or payload.get("productSegment")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    max_detail_workers = max(1, int(payload.get("maxDetailWorkers") or payload.get("detailConcurrency") or max_workers))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, str]] = []
    seen_products: set[str] = set()

    for profile in GENERALI_CHINA_LIFE_PRODUCT_PAGES:
        if profile["salesStatus"] not in status_filter or profile["segment"] not in segment_filter:
            continue
        first_page = extract_generali_china_life_listing_page(profile, 1)
        total_pages = int(first_page["page"].get("totalPages") or 1)
        if max_pages:
            total_pages = min(total_pages, max_pages)
        for page_number in range(1, total_pages + 1):
            page_result = first_page if page_number == 1 else extract_generali_china_life_listing_page(profile, page_number)
            page_products = page_result["products"]
            for product in page_products:
                if max_products and len(products) >= max_products:
                    break
                product_key = trim(product.get("detailUrl")) or f"{product['sourceKey']}|{product['productName']}"
                if product_key in seen_products:
                    continue
                seen_products.add(product_key)
                products.append({**product, "company": company})
            pages.append(page_result["page"])
            if max_products and len(products) >= max_products:
                break
        if max_products and len(products) >= max_products:
            break

    detail_results = crawl_generali_china_life_detail_tasks(products, max_workers=max_detail_workers)
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for detail_result in detail_results:
        for task in detail_result.get("tasks") or []:
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)

    records = crawl_generali_china_life_material_records(tasks, max_workers=max_workers)
    task_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for task in tasks:
        source_page = trim(task.get("sourcePage"))
        task_counts_by_page[source_page] = task_counts_by_page.get(source_page, 0) + 1
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page_meta in pages:
        page_url = trim(page_meta.get("url"))
        page_meta["materialTaskCount"] = task_counts_by_page.get(page_url, 0)
        page_meta["recordCount"] = record_counts_by_page.get(page_url, 0)

    return {
        "ok": True,
        "company": company,
        "source": "https://www.generalichina.com/termsall/",
        "officialDomain": GENERALI_CHINA_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "segment": sorted(segment_filter),
        "maxProducts": max_products,
        "maxPages": max_pages,
        "maxWorkers": max_workers,
        "maxDetailWorkers": max_detail_workers,
        "pages": pages,
        "products": products,
        "detailFetchCount": len(detail_results),
        "failedDetailCount": len([item for item in detail_results if int(item.get("status") or 0) < 200 or int(item.get("status") or 0) >= 300]),
        "materialTaskCount": len(tasks),
        "records": records,
    }


def bohai_life_source_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {page["key"] for page in BOHAI_LIFE_PRODUCT_PAGES}
    if text in {"product_info", "basic", "jbxx", "产品基本信息", "基本信息"}:
        return {"product_info"}
    if text in {"internet", "online", "互联网", "互联网保险", "互联网披露"}:
        return {"internet"}
    if text in {"archives", "archive", "资料包", "归档包"}:
        return {"in_sale_archives", "stopped_archives"}
    if text in {"in_sale_archives", "zscp", "在售产品", "在售资料包"}:
        return {"in_sale_archives"}
    if text in {"stopped_archives", "tscp", "停售产品", "停售资料包"}:
        return {"stopped_archives"}
    return {page["key"] for page in BOHAI_LIFE_PRODUCT_PAGES}


def bohai_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return set()
    if text in {"available", "in_sale", "sale", "在售", "y"}:
        return {"在售"}
    if text in {"discontinued", "stopped", "stop", "停售", "n"}:
        return {"停售"}
    if text in {"internet", "互联网", "互联网保险披露"}:
        return {"互联网保险披露"}
    return {trim(value)}


def bohai_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "团体" in name:
        return "团体保险"
    if "医疗" in name or "津贴" in name:
        return "医疗险"
    if "重大疾病" in name or "疾病" in name or "防癌" in name or "护理" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    return ""


def fetch_bohai_life_html(url: str) -> tuple[int, str]:
    proc = subprocess.run(
        [
            "curl",
            "-k",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {BOHAI_LIFE_OFFICIAL_BASE_URL}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, ""
    return 200, proc.stdout.decode("utf-8", "ignore")


def fetch_bohai_life_bytes(url: str, referer: str = "", max_bytes: int = MAX_PDF_BYTES) -> tuple[int, bytes]:
    proc = subprocess.run(
        [
            "curl",
            "-k",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {referer or BOHAI_LIFE_PRODUCT_INFO_URL}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, b""
    return 200, proc.stdout[: max_bytes + 1]


def bohai_life_normalize_url(href: str, page_url: str) -> str:
    raw = trim(href)
    if not raw:
        return ""
    candidate = urljoin(page_url, raw)
    parts = urlsplit(candidate)
    hostname = parts.hostname or ""
    path = parts.path or ""
    if hostname.startswith(("10.", "172.", "192.168.")) and path.startswith("/userfiles/"):
        candidate = urlunsplit(("https", "www.bohailife.net", path, parts.query, parts.fragment))
        parts = urlsplit(candidate)
        hostname = parts.hostname or ""
    if not hostname.lower().endswith(BOHAI_LIFE_OFFICIAL_DOMAIN):
        return ""
    return candidate


def bohai_life_material_label(label: str, title: str = "", url: str = "") -> str:
    text = clean_text(f"{label} {title} {url}")
    if "产品说明书" in text:
        return "产品说明书"
    if "产品说明" in text:
        return "产品说明"
    if "条款" in text:
        return "条款"
    return ""


def bohai_life_material_type(label: str) -> str:
    if "说明" in trim(label):
        return "product_manual"
    return "terms"


def bohai_life_product_name(cells: list[str], page_key: str) -> str:
    if page_key == "internet" and len(cells) >= 2 and re.fullmatch(r"\d+", trim(cells[0])):
        return trim(cells[1]).replace("\ufeff", "")
    if cells and re.fullmatch(r"\d+", trim(cells[0])) and len(cells) >= 2:
        return trim(cells[1]).replace("\ufeff", "")
    return trim(cells[0] if cells else "").replace("\ufeff", "")


def bohai_life_sales_status(cells: list[str], default_status: str) -> str:
    text = clean_text(" ".join(cells[-2:]))
    if "在售" in text:
        return "在售"
    if "停售" in text:
        return "停售"
    return default_status


def bohai_life_keep_material(product_name: str, raw_label: str, title: str, material_url: str) -> bool:
    if not material_url.lower().split("?", 1)[0].endswith(".pdf"):
        return False
    label = bohai_life_material_label(raw_label, title, material_url)
    if not label:
        return False
    if EXCLUDED_MATERIAL_RE.search(f"{label} {title} {material_url}"):
        return False
    if not raw_label and not product_matches(product_name, f"{title} {material_url}"):
        return False
    return True


def bohai_life_is_archive_url(material_url: str) -> bool:
    path = urlsplit(material_url).path.lower()
    return path.endswith(".rar") or path.endswith(".zip")


def bohai_life_archive_entry_url(archive_url: str, entry: str) -> str:
    return f"{archive_url}#entry={quote(entry, safe='/%:@')}"


def bohai_life_extract_archive_entries(data: bytes) -> list[tuple[str, bytes]]:
    if not data or len(data) > MAX_ZIP_BYTES:
        return []
    archive_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            archive_path = handle.name
            handle.write(data)
        listed = subprocess.run(
            ["/usr/bin/bsdtar", "-tf", archive_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
        if listed.returncode != 0:
            return []
        entries = [trim(item) for item in listed.stdout.decode("utf-8", "ignore").splitlines()]
        output: list[tuple[str, bytes]] = []
        for entry in entries:
            if not entry.lower().endswith(".pdf"):
                continue
            label = bohai_life_material_label("", entry, entry)
            if not label or EXCLUDED_MATERIAL_RE.search(entry):
                continue
            extracted = subprocess.run(
                ["/usr/bin/bsdtar", "-xOf", archive_path, entry],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=45,
            )
            if extracted.returncode != 0:
                continue
            pdf_bytes = extracted.stdout[: MAX_PDF_BYTES + 1]
            if len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF"):
                continue
            output.append((entry, pdf_bytes))
        return output
    finally:
        if archive_path:
            try:
                os.unlink(archive_path)
            except Exception:
                pass


def bohai_life_parse_page(company: str, page: dict[str, str], html: str, max_products: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = [html_text(str(cell)) for cell in row.find_all(["td", "th"])]
        if len(cells) < 3 or not row.find("a"):
            continue
        product_name = bohai_life_product_name(cells, page["key"])
        if not product_name or product_name in {"产品名称", "保险产品名称"}:
            continue
        materials: list[dict[str, str]] = []
        for anchor in row.find_all("a"):
            raw_label = html_text(str(anchor))
            title = trim(anchor.get("title") or "")
            material_url = bohai_life_normalize_url(trim(anchor.get("href")), page["url"])
            if bohai_life_is_archive_url(material_url):
                if material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                materials.append(
                    {
                        "label": "资料包",
                        "type": "archive",
                        "url": material_url,
                        "title": title,
                    }
                )
                continue
            if not bohai_life_keep_material(product_name, raw_label, title, material_url):
                continue
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            label = bohai_life_material_label(raw_label, title, material_url)
            materials.append(
                {
                    "label": label,
                    "type": bohai_life_material_type(label),
                    "url": material_url,
                    "title": title,
                }
            )
        if not materials:
            continue
        product_key = f"{page['key']}|{product_name}"
        if product_key not in seen_products:
            if max_products and len(products) >= max_products:
                break
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": bohai_life_product_type(product_name),
                    "salesStatus": bohai_life_sales_status(cells, page["defaultSalesStatus"]),
                    "sourcePage": page["url"],
                    "sourceStatus": page["key"],
                    "pageLabel": page["label"],
                }
            )
        if max_products and product_key not in seen_products:
            continue
        for material in materials:
            tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": bohai_life_product_type(product_name),
                    "salesStatus": bohai_life_sales_status(cells, page["defaultSalesStatus"]),
                    "label": material["label"],
                    "materialType": material["type"],
                    "url": material["url"],
                    "sourcePage": page["url"],
                    "sourceStatus": page["key"],
                    "pageLabel": page["label"],
                    "materialTitle": material["title"],
                }
            )
    return products, tasks


def crawl_bohai_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    hostname = urlsplit(material_url).hostname or ""
    if not hostname.lower().endswith(BOHAI_LIFE_OFFICIAL_DOMAIN):
        return None
    pdf_status, data = fetch_bohai_life_bytes(material_url, referer=trim(task.get("sourcePage")) or BOHAI_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "条款"
    return {
        "company": trim(task.get("company")) or "渤海人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or bohai_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"渤海人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or bohai_life_material_type(label),
        "official": True,
        "officialDomain": BOHAI_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_bohai_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_bohai_life_archive_material_records(task: dict[str, str]) -> list[dict[str, Any]]:
    archive_url = trim(task.get("url"))
    if not archive_url or not bohai_life_is_archive_url(archive_url):
        return []
    hostname = urlsplit(archive_url).hostname or ""
    if not hostname.lower().endswith(BOHAI_LIFE_OFFICIAL_DOMAIN):
        return []
    archive_status, archive_data = fetch_bohai_life_bytes(
        archive_url,
        referer=trim(task.get("sourcePage")) or BOHAI_LIFE_PRODUCT_INFO_URL,
        max_bytes=MAX_ZIP_BYTES,
    )
    if archive_status < 200 or archive_status >= 300 or len(archive_data) > MAX_ZIP_BYTES:
        return []
    records: list[dict[str, Any]] = []
    product_name = trim(task.get("productName"))
    for entry, pdf_bytes in bohai_life_extract_archive_entries(archive_data):
        label = bohai_life_material_label("", entry, entry)
        if not label:
            continue
        extracted = extract_pdf_text_with_system_python(pdf_bytes)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        if not page_text or "保险责任" not in page_text:
            continue
        entry_url = bohai_life_archive_entry_url(archive_url, entry)
        records.append(
            {
                "company": trim(task.get("company")) or "渤海人寿",
                "productName": product_name,
                "productType": trim(task.get("productType")) or bohai_life_product_type(product_name),
                "salesStatus": trim(task.get("salesStatus")),
                "title": f"{product_name}{label}",
                "url": entry_url,
                "snippet": f"渤海人寿官网{trim(task.get('pageLabel'))}{label}，已从资料包内PDF截取保险责任正文段。",
                "pageText": page_text,
                "sourceType": "pdf",
                "materialType": bohai_life_material_type(label),
                "official": True,
                "officialDomain": BOHAI_LIFE_OFFICIAL_DOMAIN,
                "parser": "scrapling_bohai_life_product_archive",
                "pages": extracted.get("pages", 0),
                "bytes": len(pdf_bytes),
                "archiveUrl": archive_url,
                "archiveEntry": entry,
            }
        )
    return records


def crawl_bohai_life_material_task_records(task: dict[str, str]) -> list[dict[str, Any]]:
    if trim(task.get("materialType")) == "archive" or bohai_life_is_archive_url(trim(task.get("url"))):
        return crawl_bohai_life_archive_material_records(task)
    record = crawl_bohai_life_material_record(task)
    return [record] if record else []


def crawl_bohai_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_bohai_life_material_task_records(task))
        return records
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_bohai_life_material_task_records, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return records


def crawl_bohai_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "渤海人寿"
    source_filter = bohai_life_source_filter(trim(payload.get("source") or payload.get("page")))
    status_filter = bohai_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()

    for page in BOHAI_LIFE_PRODUCT_PAGES:
        if page["key"] not in source_filter:
            continue
        status, html = fetch_bohai_life_html(page["url"])
        page_meta = {
            "url": page["url"],
            "status": status,
            "label": page["label"],
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300 or not html:
            pages.append(page_meta)
            continue
        remaining = max(0, max_products - len(products)) if max_products else 0
        page_products, page_tasks = bohai_life_parse_page(company, page, html, remaining)
        allowed_names = {trim(product.get("productName")) for product in page_products}
        for product in page_products:
            if status_filter and trim(product.get("salesStatus")) not in status_filter:
                continue
            products.append(product)
        page_task_count = 0
        for task in page_tasks:
            if max_products and trim(task.get("productName")) not in allowed_names:
                continue
            if status_filter and trim(task.get("salesStatus")) not in status_filter:
                continue
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_task_urls:
                continue
            seen_task_urls.add(material_url)
            tasks.append(task)
            page_task_count += 1
        page_meta["productCount"] = len([product for product in page_products if not status_filter or trim(product.get("salesStatus")) in status_filter])
        page_meta["materialTaskCount"] = page_task_count
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    records = crawl_bohai_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    for record in records:
        record_url = trim(record.get("url"))
        archive_base = record_url.split("#entry=", 1)[0]
        page_url = task_page_by_url.get(record_url) or task_page_by_url.get(archive_base)
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": BOHAI_LIFE_PRODUCT_INFO_URL,
        "officialDomain": BOHAI_LIFE_OFFICIAL_DOMAIN,
        "sourceFilter": sorted(source_filter),
        "saleStatus": sorted(status_filter) if status_filter else ["all"],
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def read_archive_entry_pdf(material_url: str, referer: str = "") -> tuple[int, str, bytes, str]:
    split_url = material_url.split("#entry=", 1)
    if len(split_url) != 2:
        return 0, "", b"", ""
    archive_url, entry_ref = split_url
    archive_path_lower = urlsplit(archive_url).path.lower()
    is_zip = archive_path_lower.endswith(".zip")
    is_rar = archive_path_lower.endswith(".rar")
    if not is_zip and not is_rar:
        return 0, "", b"", ""
    host = urlsplit(archive_url).hostname or ""
    cookie_header = read_cathay_life_cookie_header() if "cathaylife.cn" in host else ""
    if cookie_header:
        status, content_type, data = fetch_bytes_with_cathay_cookies(
            archive_url,
            referer=referer or CATHAY_LIFE_FILING_URL,
            cookie_header=cookie_header,
            max_bytes=MAX_ZIP_BYTES,
        )
    else:
        try:
            status, data = fetch_bytes(archive_url)
            content_type = ""
        except Exception:
            status, content_type, data = 0, "", b""
        if not data or (is_zip and not data.startswith(b"PK")) or (is_rar and not data.startswith(b"Rar!")):
            status, content_type, data = fetch_binary_direct(archive_url, referer=referer, max_bytes=MAX_ZIP_BYTES)
    if status < 200 or status >= 300 or len(data) > MAX_ZIP_BYTES:
        return status, content_type, b"", ""
    if is_rar:
        return read_rar_entry_pdf(data, entry_ref, status, content_type)
    if not data.startswith(b"PK"):
        return status, content_type, b"", ""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return status, content_type, b"", ""

    decoded_ref = unquote(entry_ref)
    wanted_index = -1
    index_match = re.match(r"(\d+)(?:-|$)", decoded_ref)
    if index_match:
        try:
            wanted_index = int(index_match.group(1))
        except Exception:
            wanted_index = -1
    infos = archive.infolist()
    candidates = []
    if 0 <= wanted_index < len(infos):
        candidates.append(infos[wanted_index])
    wanted_name = re.sub(r"^\d+-", "", decoded_ref).replace("\\", "/")
    for info in infos:
        decoded_name = cathay_life_decode_zip_filename(info.filename).replace("\\", "/")
        basename = decoded_name.rsplit("/", 1)[-1]
        if wanted_name and (wanted_name == decoded_name or wanted_name == basename or wanted_name in decoded_name):
            candidates.append(info)

    seen_names = set()
    for info in candidates:
        if info.filename in seen_names or info.file_size <= 0 or info.file_size > MAX_PDF_BYTES:
            continue
        seen_names.add(info.filename)
        try:
            pdf_bytes = archive.read(info)
        except Exception:
            continue
        if pdf_bytes.startswith(b"%PDF"):
            return status, content_type, pdf_bytes, cathay_life_decode_zip_filename(info.filename)
    return status, content_type, b"", ""


def read_zip_entry_pdf_from_data(data: bytes, entry_ref: str) -> tuple[bytes, str]:
    if not data or len(data) > MAX_ZIP_BYTES or not data.startswith(b"PK"):
        return b"", ""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return b"", ""
    decoded_ref = unquote(entry_ref)
    wanted_index = -1
    index_match = re.match(r"(\d+)(?:-|$)", decoded_ref)
    if index_match:
        try:
            wanted_index = int(index_match.group(1))
        except Exception:
            wanted_index = -1
    infos = archive.infolist()
    candidates = []
    if 0 <= wanted_index < len(infos):
        candidates.append(infos[wanted_index])
    wanted_name = re.sub(r"^\d+-", "", decoded_ref).replace("\\", "/")
    for info in infos:
        decoded_name = cathay_life_decode_zip_filename(info.filename).replace("\\", "/")
        basename = decoded_name.rsplit("/", 1)[-1]
        if wanted_name and (wanted_name == decoded_name or wanted_name == basename or wanted_name in decoded_name):
            candidates.append(info)
    seen_names = set()
    for info in candidates:
        if info.filename in seen_names or info.file_size <= 0 or info.file_size > MAX_PDF_BYTES:
            continue
        seen_names.add(info.filename)
        try:
            pdf_bytes = archive.read(info)
        except Exception:
            continue
        if pdf_bytes.startswith(b"%PDF"):
            return pdf_bytes, cathay_life_decode_zip_filename(info.filename)
    return b"", ""


def read_rar_entry_pdf(data: bytes, entry_ref: str, status: int, content_type: str) -> tuple[int, str, bytes, str]:
    bsdtar = os.environ.get("BSDTAR_BIN") or "/usr/bin/bsdtar"
    decoded_ref = unquote(entry_ref).replace("\\", "/")
    wanted_index = -1
    index_match = re.match(r"(\d+)(?:-|$)", decoded_ref)
    if index_match:
        try:
            wanted_index = int(index_match.group(1))
        except Exception:
            wanted_index = -1
    wanted_name = re.sub(r"^\d+-", "", decoded_ref)
    archive_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".rar") as handle:
            archive_path = handle.name
            handle.write(data)
        listed = subprocess.run(
            [bsdtar, "-tf", archive_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=40,
        )
        if listed.returncode != 0:
            return status, content_type, b"", ""
        entries = [item.strip().replace("\\", "/") for item in listed.stdout.decode("utf-8", "ignore").splitlines() if item.strip()]
        candidates: list[str] = []
        if 0 <= wanted_index < len(entries):
            candidates.append(entries[wanted_index])
        wanted_base = wanted_name.rsplit("/", 1)[-1]
        for entry in entries:
            entry_base = entry.rsplit("/", 1)[-1]
            if wanted_name and (wanted_name == entry or wanted_name == entry_base or wanted_name in entry or wanted_base == entry_base):
                candidates.append(entry)
        for entry in entries:
            if entry.lower().endswith(".pdf") and entry not in candidates:
                candidates.append(entry)
        seen_entries = set()
        for entry in candidates:
            if entry in seen_entries or not entry.lower().endswith(".pdf"):
                continue
            seen_entries.add(entry)
            extracted = subprocess.run(
                [bsdtar, "-xOf", archive_path, entry],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=60,
            )
            if extracted.returncode != 0:
                continue
            pdf_bytes = extracted.stdout[: MAX_PDF_BYTES + 1]
            if len(pdf_bytes) <= MAX_PDF_BYTES and pdf_bytes.startswith(b"%PDF"):
                return status, content_type or "application/x-rar-compressed", pdf_bytes, entry
    finally:
        if archive_path:
            try:
                os.unlink(archive_path)
            except Exception:
                pass
    return status, content_type, b"", ""


def reextract_responsibility_record(task: dict[str, Any]) -> dict[str, Any]:
    product_name = trim(task.get("productName"))
    material_url = trim(task.get("url"))
    if not product_name or not material_url:
        return {
            "ok": False,
            "id": trim(task.get("id")),
            "productName": product_name,
            "url": material_url,
            "reason": "missing_product_or_url",
        }

    status, content_type, data = 0, "", b""
    archive_entry_name = ""
    host = urlsplit(material_url.split("#", 1)[0]).hostname or ""
    if "#entry=" in material_url:
        try:
            status, content_type, data, archive_entry_name = read_archive_entry_pdf(
                material_url,
                referer=trim(task.get("sourcePage")),
            )
        except Exception as error:
            content_type = f"archive_entry_error:{error}"
            data = b""
    if not data and "cathaylife.cn" in host:
        cookie_header = read_cathay_life_cookie_header()
        if cookie_header:
            try:
                status, content_type, data = fetch_bytes_with_cathay_cookies(
                    material_url,
                    referer=trim(task.get("sourcePage")) or CATHAY_LIFE_OFFICIAL_BASE_URL,
                    cookie_header=cookie_header,
                    max_bytes=MAX_ZIP_BYTES if material_url.lower().split("#", 1)[0].endswith(".zip") else MAX_PDF_BYTES,
                )
            except Exception as error:
                content_type = f"fetch_cathay_cookie_error:{error}"
                data = b""
    if not data and ".pdf" in material_url.lower():
        try:
            status, content_type, data = fetch_binary_direct(
                material_url,
                referer=trim(task.get("sourcePage")) or PING_AN_PRODUCT_LIST_ENDPOINT,
            )
        except Exception as error:
            content_type = f"fetch_binary_direct_error:{error}"
            data = b""
    if not data:
        cookie_header = read_cathay_life_cookie_header() if "cathaylife.cn" in host else ""
        if cookie_header:
            try:
                status, content_type, data = fetch_bytes_with_cathay_cookies(
                    material_url,
                    referer=trim(task.get("sourcePage")) or CATHAY_LIFE_OFFICIAL_BASE_URL,
                    cookie_header=cookie_header,
                )
            except Exception as error:
                content_type = f"fetch_cathay_cookie_error:{error}"
                data = b""
        else:
            try:
                status, data = fetch_bytes(material_url)
            except Exception as error:
                content_type = f"fetch_bytes_error:{error}"
    if not data.startswith(b"%PDF"):
        try:
            status, content_type, data = fetch_binary_direct(
                material_url,
                referer=trim(task.get("sourcePage")) or PING_AN_PRODUCT_LIST_ENDPOINT,
            )
        except Exception as error:
            content_type = f"fetch_binary_direct_error:{error}"
            data = b""
    if data and not data.startswith(b"%PDF") and "cathaylife.cn" in host:
        cookie_header = read_cathay_life_cookie_header()
        if cookie_header:
            try:
                status, content_type, data = fetch_bytes_with_cathay_cookies(
                    material_url,
                    referer=trim(task.get("sourcePage")) or CATHAY_LIFE_OFFICIAL_BASE_URL,
                    cookie_header=cookie_header,
                    max_bytes=MAX_ZIP_BYTES if material_url.lower().split("#", 1)[0].endswith(".zip") else MAX_PDF_BYTES,
                )
            except Exception as error:
                content_type = f"fetch_cathay_cookie_error:{error}"
                data = b""

    if data and not data.startswith(b"%PDF"):
        decoded = data[:MAX_PDF_BYTES].decode("utf-8", "ignore")
        if decoded:
            lower_head = decoded[:2000].lower()
            source_text = html_text(decoded) if "<html" in lower_head or "<body" in lower_head or "</" in lower_head else decoded
            page_text = focused_responsibility_excerpt(source_text)
            if page_text:
                material_type_value = trim(task.get("materialType")) or ("html" if ".html" in material_url.lower() else ping_an_material_type_from_url(material_url))
                title = trim(task.get("title")) or f"{product_name}{'产品说明书' if material_type_value == 'product_manual' else '产品条款'}"
                company = trim(task.get("company")) or "中国平安"
                return {
                    "ok": True,
                    "record": {
                        "id": trim(task.get("id")),
                        "company": company,
                        "productName": product_name,
                        "productType": trim(task.get("productType")),
                        "salesStatus": trim(task.get("salesStatus")),
                        "title": title,
                        "url": material_url,
                        "snippet": f"{company}官网页面，已重新抽取保险责任正文段。",
                        "pageText": page_text,
                        "sourceType": "html",
                        "materialType": material_type_value,
                        "official": True,
                        "officialDomain": trim(task.get("officialDomain")) or (urlsplit(material_url).hostname or ""),
                        "parser": "scrapling_responsibility_refill_html",
                        "pages": 0,
                        "bytes": len(data),
                        "contentType": content_type,
                        "archiveEntry": archive_entry_name,
                    },
                }

    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return {
            "ok": False,
            "id": trim(task.get("id")),
            "productName": product_name,
            "url": material_url,
            "status": status,
            "contentType": content_type,
            "bytes": len(data),
            "reason": "pdf_unavailable",
        }

    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return {
            "ok": False,
            "id": trim(task.get("id")),
            "productName": product_name,
            "url": material_url,
            "status": status,
            "contentType": content_type,
            "bytes": len(data),
            "pages": extracted.get("pages", 0),
            "reason": "no_responsibility_text",
        }

    material_type_value = trim(task.get("materialType")) or ping_an_material_type_from_url(material_url)
    title = trim(task.get("title")) or f"{product_name}{'产品说明书' if material_type_value == 'product_manual' else '产品条款'}"
    company = trim(task.get("company")) or "中国平安"
    return {
        "ok": True,
        "record": {
            "id": trim(task.get("id")),
            "company": company,
            "productName": product_name,
            "productType": trim(task.get("productType")),
            "salesStatus": trim(task.get("salesStatus")),
            "title": title,
            "url": material_url,
            "snippet": f"{company}官网资料，已重新抽取保险责任正文段。",
            "pageText": page_text,
            "sourceType": "pdf",
            "materialType": material_type_value,
            "official": True,
            "officialDomain": trim(task.get("officialDomain")) or (urlsplit(material_url).hostname or ""),
            "parser": "scrapling_responsibility_refill",
            "pages": extracted.get("pages", 0),
            "bytes": len(data),
            "contentType": content_type,
            "archiveEntry": archive_entry_name,
        },
    }


def reextract_responsibility_records(payload: dict[str, Any]) -> dict[str, Any]:
    tasks = payload.get("records") if isinstance(payload.get("records"), list) else payload.get("tasks")
    if not isinstance(tasks, list):
        tasks = []
    max_workers = max(1, min(8, int(payload.get("maxWorkers") or payload.get("concurrency") or 3)))
    records: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    if not tasks:
        return {"ok": True, "taskCount": 0, "recordCount": 0, "skippedCount": 0, "records": [], "skipped": []}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_task = {executor.submit(reextract_responsibility_record, task): task for task in tasks}
        for future in as_completed(future_to_task):
            try:
                result = future.result()
            except Exception as error:
                task = future_to_task[future]
                skipped.append(
                    {
                        "id": trim(task.get("id")),
                        "productName": trim(task.get("productName")),
                        "url": trim(task.get("url")),
                        "reason": f"exception:{error}",
                    }
                )
                continue
            if result.get("ok") and isinstance(result.get("record"), dict):
                records.append(result["record"])
            else:
                skipped.append({key: value for key, value in result.items() if key != "ok"})
    return {
        "ok": True,
        "taskCount": len(tasks),
        "recordCount": len(records),
        "skippedCount": len(skipped),
        "records": records,
        "skipped": skipped,
    }


async def cathay_browser_fetch_material(context: Any, material_url: str) -> tuple[int, str, bytes, str]:
    archive_entry_name = ""
    base_url, entry_ref = (material_url.split("#entry=", 1) + [""])[:2] if "#entry=" in material_url else (material_url, "")
    response = await context.request.get(
        base_url,
        headers={"Referer": CATHAY_LIFE_OFFICIAL_BASE_URL, "Accept": "application/zip,application/pdf,*/*"},
        timeout=60000,
    )
    data = await response.body()
    status = int(response.status or 0)
    content_type = trim(response.headers.get("content-type", ""))
    if entry_ref:
        pdf_bytes, archive_entry_name = read_zip_entry_pdf_from_data(data, entry_ref)
        return status, content_type, pdf_bytes, archive_entry_name
    return status, content_type, data[: MAX_PDF_BYTES + 1], archive_entry_name


def cathay_browser_record_from_pdf(task: dict[str, Any], data: bytes, content_type: str, archive_entry_name: str = "") -> dict[str, Any] | None:
    if not data or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    material_type_value = trim(task.get("materialType")) or cathay_life_material_type(trim(task.get("title")))
    title = trim(task.get("title")) or f"{product_name}{'产品说明书' if material_type_value == 'product_manual' else '产品条款'}"
    company = trim(task.get("company")) or "陆家嘴国泰人寿"
    return {
        "id": trim(task.get("id")),
        "company": company,
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": title,
        "url": trim(task.get("url")),
        "snippet": f"{company}官网资料，已通过浏览器会话重新抽取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": material_type_value,
        "official": True,
        "officialDomain": "www.cathaylife.cn",
        "parser": "scrapling_responsibility_refill_cathay_browser",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "archiveEntry": archive_entry_name,
    }


async def reextract_cathay_responsibility_records_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": [], "skipped": []}
    tasks = payload.get("records") if isinstance(payload.get("records"), list) else payload.get("tasks")
    if not isinstance(tasks, list):
        tasks = []
    user_data_dir = trim(payload.get("userDataDir")) or "/tmp/chrome-cathaylife-crawl"
    headless_value = trim(payload.get("headless"))
    headless = headless_value.lower() in {"1", "true", "yes"}
    records: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir,
            headless=headless,
            executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            args=["--no-first-run", "--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900},
        )
        try:
            page = await context.new_page()
            await page.goto(CATHAY_LIFE_OFFICIAL_BASE_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(int(payload.get("warmupMs") or 12000))
            for task in tasks:
                material_url = trim(task.get("url"))
                product_name = trim(task.get("productName"))
                try:
                    status, content_type, data, archive_entry_name = await cathay_browser_fetch_material(context, material_url)
                    record = cathay_browser_record_from_pdf(task, data, content_type, archive_entry_name)
                    if record:
                        records.append(record)
                    else:
                        skipped.append(
                            {
                                "id": trim(task.get("id")),
                                "productName": product_name,
                                "url": material_url,
                                "status": status,
                                "contentType": content_type,
                                "bytes": len(data),
                                "reason": "no_responsibility_text" if data.startswith(b"%PDF") else "pdf_unavailable",
                            }
                        )
                except Exception as error:
                    skipped.append(
                        {
                            "id": trim(task.get("id")),
                            "productName": product_name,
                            "url": material_url,
                            "reason": f"exception:{error}",
                        }
                    )
        finally:
            await context.close()
    return {
        "ok": True,
        "taskCount": len(tasks),
        "recordCount": len(records),
        "skippedCount": len(skipped),
        "records": records,
        "skipped": skipped,
    }


def reextract_cathay_responsibility_records(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(reextract_cathay_responsibility_records_async(payload))


def crawl_policy(payload: dict[str, Any]) -> dict[str, Any]:
    if trim(payload.get("mode")) == "reextract_cathay_responsibility_records_browser":
        return reextract_cathay_responsibility_records(payload)
    if trim(payload.get("mode")) == "reextract_responsibility_records":
        return reextract_responsibility_records(payload)
    if trim(payload.get("mode")) == "new_china_pages":
        return crawl_new_china_pages(payload)
    if trim(payload.get("mode")) == "china_life_pages":
        return crawl_china_life_pages(payload)
    if trim(payload.get("mode")) == "china_united_life_pages":
        return crawl_china_united_life_pages(payload)
    if trim(payload.get("mode")) == "picc_life_pages":
        return crawl_picc_life_pages(payload)
    if trim(payload.get("mode")) == "ping_an_pages":
        return crawl_ping_an_pages(payload)
    if trim(payload.get("mode")) == "ping_an_browser_pages":
        return crawl_ping_an_browser_pages(payload)
    if trim(payload.get("mode")) == "ping_an_browser_catalog_materials":
        return crawl_ping_an_browser_catalog_materials(payload)
    if trim(payload.get("mode")) == "ping_an_browser_catalog":
        return crawl_ping_an_browser_catalog(payload)
    if trim(payload.get("mode")) == "taikang_life_pages":
        return crawl_taikang_life_pages(payload)
    if trim(payload.get("mode")) == "sunshine_life_browser_pages":
        return crawl_sunshine_life_browser_pages(payload)
    if trim(payload.get("mode")) == "guohua_life_pages":
        return crawl_guohua_life_pages(payload)
    if trim(payload.get("mode")) == "happy_life_pages":
        return crawl_happy_life_pages(payload)
    if trim(payload.get("mode")) == "caixin_life_pages":
        return crawl_caixin_life_pages(payload)
    if trim(payload.get("mode")) == "china_taiping_pages":
        return crawl_china_taiping_pages(payload)
    if trim(payload.get("mode")) == "china_taiping_disclosure_html":
        return crawl_china_taiping_disclosure_html(payload)
    if trim(payload.get("mode")) == "cpic_life_pages":
        return crawl_cpic_life_pages(payload)
    if trim(payload.get("mode")) == "aia_life_pages":
        return crawl_aia_life_pages(payload)
    if trim(payload.get("mode")) == "ccb_life_pages":
        return crawl_ccb_life_pages(payload)
    if trim(payload.get("mode")) == "minsheng_life_pages":
        return crawl_minsheng_life_pages(payload)
    if trim(payload.get("mode")) == "cathay_life_pages":
        return crawl_cathay_life_pages(payload)
    if trim(payload.get("mode")) == "cathay_life_filing_pages":
        return crawl_cathay_life_filing_pages(payload)
    if trim(payload.get("mode")) == "union_life_pages":
        return crawl_union_life_pages(payload)
    if trim(payload.get("mode")) == "bocomm_life_pages":
        return crawl_bocomm_life_pages(payload)
    if trim(payload.get("mode")) == "xintai_life_product_info":
        return crawl_xintai_life_product_info(payload)
    if trim(payload.get("mode")) == "xintai_life_internet_products":
        return crawl_xintai_life_internet_products(payload)
    if trim(payload.get("mode")) == "metlife_china_life_pages":
        return crawl_metlife_china_life_pages(payload)
    if trim(payload.get("mode")) == "abc_life_pages":
        return crawl_abc_life_pages(payload)
    if trim(payload.get("mode")) == "icbc_axa_life_pages":
        return crawl_icbc_axa_life_pages(payload)
    if trim(payload.get("mode")) == "aviva_cofco_life_pages":
        return crawl_aviva_cofco_life_pages(payload)
    if trim(payload.get("mode")) == "greatwall_life_pages":
        return crawl_greatwall_life_pages(payload)
    if trim(payload.get("mode")) == "guofu_life_pages":
        return crawl_guofu_life_pages(payload)
    if trim(payload.get("mode")) == "china_post_life_pages":
        return crawl_china_post_life_pages(payload)
    if trim(payload.get("mode")) == "cmrh_life_pages":
        return crawl_cmrh_life_pages(payload)
    if trim(payload.get("mode")) == "aeon_life_pages":
        return crawl_aeon_life_pages(payload)
    if trim(payload.get("mode")) == "manulife_sinochem_life_pages":
        return crawl_manulife_sinochem_life_pages(payload)
    if trim(payload.get("mode")) == "sunlife_everbright_life_pages":
        return crawl_sunlife_everbright_life_pages(payload)
    if trim(payload.get("mode")) == "aegon_thtf_life_pages":
        return crawl_aegon_thtf_life_pages(payload)
    if trim(payload.get("mode")) == "generali_china_life_pages":
        return crawl_generali_china_life_pages(payload)
    if trim(payload.get("mode")) == "bohai_life_pages":
        return crawl_bohai_life_pages(payload)
    if trim(payload.get("mode")) == "lian_life_pages":
        return crawl_lian_life_pages(payload)
    company = trim(payload.get("company"))
    product_name = trim(payload.get("name") or payload.get("productName"))
    if not company or not product_name:
        return {"ok": False, "code": "POLICY_REQUIRED", "records": []}
    if "新华" in company or "新华" in product_name:
        records = crawl_new_china(company, product_name)
    else:
        records = []
    return {"ok": True, "company": company, "productName": product_name, "records": records}


def main() -> None:
    logging.getLogger().setLevel(logging.ERROR)
    raw = sys.stdin.read()
    payload = json.loads(raw or "{}")
    result = crawl_policy(payload)
    print(f"{OUTPUT_MARKER}{json.dumps(result, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
