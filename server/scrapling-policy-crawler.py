#!/usr/bin/env python3
import base64
import asyncio
import hmac
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
import time
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
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PDF_ARCHIVE_DIR = os.path.join(PROJECT_ROOT, ".runtime", "policy-material-pdfs")
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
GUOLIAN_LIFE_OFFICIAL_BASE_URL = "https://www.guolian-life.com/"
GUOLIAN_LIFE_WEB_BASE_URL = "https://www.guolian-life.com/web/"
GUOLIAN_LIFE_PRODUCT_PAGE_URL = "https://www.guolian-life.com/web/#/relatedTransaction.html"
GUOLIAN_LIFE_OFFICIAL_DOMAINS = {"guolian-life.com", "www.guolian-life.com", "eservice.guolian-life.com"}
GUOLIAN_LIFE_PRODUCT_MENUS = {
    "in_sale": {"menuCode": "1875", "grade": "4", "salesStatus": "在售", "label": "在售产品目录"},
    "stopped": {"menuCode": "1874", "grade": "4", "salesStatus": "停售", "label": "停售产品目录"},
}
PING_AN_PRODUCT_LIST_ENDPOINT = "https://life.pingan.com/ilife-home/product/getProductList"
PING_AN_PLAN_PDF_ENDPOINT = "https://life.pingan.com/ilife-home/product/getPlanClausePdf"
PING_AN_LOAN_RATE_PDF_URL = "https://life.pingan.com/ilifecore/biaogexiazai/baodandaikuanlilv.pdf"
JRCPCX_DETAIL_BASE_URL = "https://inspdinfo.iachina.cn"
JRCPCX_DETAIL_AES_KEY = "0d36c68466e06b99"
JRCPCX_DETAIL_AES_IV = "0840e274812143f5"
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
ZHONGAN_PRODUCT_INFO_URL = "https://www.zhongan.com/channel/public/publicInfo_cpjbxx2018.html"
ZHONGAN_OFFICIAL_DOMAIN = "www.zhongan.com"
ZHONGAN_STATIC_DOMAIN = "static.zhongan.com"
HONGKANG_LIFE_OFFICIAL_BASE_URL = "https://www.hongkang-life.com/"
HONGKANG_LIFE_PRODUCT_INFO_URL = "https://www.hongkang-life.com/hongkang/productBasicInformation.html"
HONGKANG_LIFE_PRODUCT_CLAUSE_ENDPOINT = "https://www.hongkang-life.com/seerkey-iif-web-portal-1.0.0/disclosure/productClause/queryByStatus"
HONGKANG_LIFE_OFFICIAL_DOMAIN = "www.hongkang-life.com"
HONGKANG_LIFE_SALE_STATUSES = {"1": "在售", "0": "停售"}
ZHONGAN_PRODUCT_PAGES = [
    {"label": "健康险", "path": "/channel/public/cpjbxx2021_jkx.html", "productType": "医疗险"},
    {"label": "意外险", "path": "/channel/public/cpjbxx2021_ywx.html", "productType": "意外险"},
    {"label": "家庭/企业财产险", "path": "/channel/public/cpjbxx2021_jtqyccx.html", "productType": "其他"},
    {"label": "责任险", "path": "/channel/public/cpjbxx2021_zrx.html", "productType": "其他"},
    {"label": "信用保证险", "path": "/channel/public/cpjbxx2021_xybzx.html", "productType": "其他"},
    {"label": "货运险", "path": "/channel/public/cpjbxx2021_hyx.html", "productType": "其他"},
    {"label": "机动车辆保险", "path": "/channel/public/cpjbxx2021_jdclbx.html", "productType": "其他"},
    {"label": "其他险", "path": "/channel/public/cpjbxx2021_qt.html", "productType": "其他"},
]
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
XIAOKANG_LIFE_OFFICIAL_BASE_URL = "https://www.livit-life.com/"
XIAOKANG_LIFE_PRODUCT_INFO_URL = "https://www.livit-life.com/1/37/index.html"
XIAOKANG_LIFE_OFFICIAL_DOMAINS = {"livit-life.com", "www.livit-life.com"}
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
GUOBAO_LIFE_OFFICIAL_BASE_URL = "https://www.panda-assets.com/"
GUOBAO_LIFE_PRODUCT_INFO_URL = "https://www.panda-assets.com/PublicInfo/Index/114"
GUOBAO_LIFE_OFFICIAL_DOMAIN = "www.panda-assets.com"
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
YINGDA_LIFE_OFFICIAL_BASE_URL = "https://www.ydthlife.com/"
YINGDA_LIFE_OFFICIAL_DOMAIN = "www.ydthlife.com"
YINGDA_LIFE_PRODUCT_PAGES = [
    {
        "url": "https://www.ydthlife.com/gkxxpl/jbxx/cpjbxx/jbtk/zsjkbx/grbxcp/index.shtml",
        "salesStatus": "在售",
        "sourceGroup": "personal",
        "pageLabel": "在售个人保险产品",
    },
    {
        "url": "https://www.ydthlife.com/gkxxpl/jbxx/cpjbxx/jbtk/zsjkbx/tsbxcp/index.shtml",
        "salesStatus": "在售",
        "sourceGroup": "group",
        "pageLabel": "在售团体保险产品",
    },
    {
        "url": "https://www.ydthlife.com/gkxxpl/jbxx/cpjbxx/jbtk/tsbxnp/grbxcp/index.shtml",
        "salesStatus": "停售",
        "sourceGroup": "personal",
        "pageLabel": "停售个人保险产品",
    },
    {
        "url": "https://www.ydthlife.com/gkxxpl/jbxx/cpjbxx/jbtk/tsbxnp/ttbxcp/index.shtml",
        "salesStatus": "停售",
        "sourceGroup": "group",
        "pageLabel": "停售团体保险产品",
    },
]
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
HAIBAO_LIFE_OFFICIAL_BASE_URL = "https://www.haibao-life.com/"
HAIBAO_LIFE_OFFICIAL_DOMAIN = "www.haibao-life.com"
HAIBAO_LIFE_PRODUCT_PAGES = [
    {
        "key": "in_sale",
        "baseUrl": "https://www.haibao-life.com/gkxxpl/cpjbxx/zscp/",
        "pageCount": 4,
        "salesStatus": "在售",
    },
    {
        "key": "stopped",
        "baseUrl": "https://www.haibao-life.com/gkxxpl/cpjbxx/tscp/",
        "pageCount": 9,
        "salesStatus": "停售",
    },
]
HSBC_LIFE_PRODUCT_INFO_URL = "https://www.hsbcinsurance.com.cn/about-us/information-disclosure/basic-information/"
HSBC_LIFE_OFFICIAL_BASE_URL = "https://www.hsbcinsurance.com.cn/"
HSBC_LIFE_OFFICIAL_DOMAIN = "www.hsbcinsurance.com.cn"
HUAGUI_LIFE_PRODUCT_INFO_URL = "https://www.huaguilife.cn/index/hgpcgw/generate/web/gkxxpl/jbxx/chanpinjibenxinxi/index.html?secondTypeId=1610578396749713410"
HUAGUI_LIFE_OFFICIAL_BASE_URL = "https://www.huaguilife.cn/"
HUAGUI_LIFE_OFFICIAL_DOMAIN = "www.huaguilife.cn"
HUAHUI_LIFE_OFFICIAL_BASE_URL = "https://www.sciclife.com/"
HUAHUI_LIFE_PRODUCT_TERMS_URL = "https://www.sciclife.com/base_survey/_content/13_05/02/1367479651970_1.html"
HUAHUI_LIFE_PRODUCT_MANUAL_URL = "https://www.sciclife.com/base_product/_content/18_07/03/1530602814577_3.html"
HUAHUI_LIFE_OFFICIAL_DOMAIN = "www.sciclife.com"
HUAHUI_LIFE_OFFICIAL_DOMAINS = {"www.sciclife.com", "sciclife.com"}
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
BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL = "https://www.boc-samsunglife.cn/"
BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN = "www.boc-samsunglife.cn"
BOC_SAMSUNG_LIFE_PRODUCT_LIST_ENDPOINT = "https://www.boc-samsunglife.cn/api/v1/bocsamsung/pc/component/goods/goodsInfoListPage"
BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT = "https://www.boc-samsunglife.cn/api/v1/bocsamsung/pc/component/products/productInfoListPage"
BOC_SAMSUNG_LIFE_GOODS_DETAIL_ENDPOINT = "https://www.boc-samsunglife.cn/api/v1/bocsamsung/pc/component/goods"
BOC_SAMSUNG_LIFE_SM4_KEY_HEX = "dde468e48994f709ff89f985467733ab"
BOC_SAMSUNG_LIFE_HMAC_KEY = "cc8d41d6099085a54eb9606db15a8e3ae792496c3a1575775a79ed469e324856"
BOC_SAMSUNG_LIFE_EXCLUDED_MATERIAL_RE = re.compile(
    r"费率|费率表|现金价值|利益演示|产品分类|声明书|总精算师|法律责任人|投保须知|职业分类|理赔服务|特别说明|健康告知|客户告知|清单",
    re.I,
)
SINOKOREA_LIFE_OFFICIAL_BASE_URL = "https://www.sinokorealife.com.cn/"
SINOKOREA_LIFE_PRODUCT_INFO_URL = "https://www.sinokorealife.com.cn/gkxxpl.jhtml"
SINOKOREA_LIFE_OFFICIAL_DOMAIN = "www.sinokorealife.com.cn"
SINOKOREA_LIFE_OFFICIAL_DOMAINS = {"sinokorealife.com.cn", "www.sinokorealife.com.cn"}
CHANGSHENG_LIFE_OFFICIAL_BASE_URL = "https://www.gwcslife.com/"
CHANGSHENG_LIFE_PRODUCT_INFO_URL = "https://www.gwcslife.com/main/index/gkxxplzl/jbxx/index.html"
CHANGSHENG_LIFE_OFFICIAL_DOMAIN = "www.gwcslife.com"
CHANGSHENG_LIFE_OFFICIAL_DOMAINS = {"gwcslife.com", "www.gwcslife.com"}
CHANGSHENG_LIFE_PRODUCT_PAGES = [
    {
        "url": "https://www.gwcslife.com/main/index/gkxxplzl/jbxx/cpjbxx/4806/index.html",
        "salesStatus": "在售",
    },
    {
        "url": "https://www.gwcslife.com/main/index/gkxxplzl/jbxx/cpjbxx/4976/index.html",
        "salesStatus": "停售",
    },
]
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
BEIJING_LIFE_OFFICIAL_BASE_URL = "https://www.beijinglife.com.cn/"
BEIJING_LIFE_PRODUCT_INFO_URL = "https://www.beijinglife.com.cn/publicInfo/basicInfo/productBasicInfo/"
BEIJING_LIFE_OFFICIAL_DOMAINS = {"beijinglife.com.cn", "www.beijinglife.com.cn", "blife.com.cn", "www.blife.com.cn"}
RUITAI_LIFE_OFFICIAL_BASE_URL = "https://www.oldmutual-chnenergy.com/"
RUITAI_LIFE_PRODUCT_TERMS_URL = "https://www.oldmutual-chnenergy.com/onlineService/customerService/prosuctClause/"
RUITAI_LIFE_OFFICIAL_DOMAINS = {
    "oldmutual-chnenergy.com",
    "www.oldmutual-chnenergy.com",
    "oldmutual-guodian.com",
    "www.oldmutual-guodian.com",
}
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
FOSUN_PRUDENTIAL_OFFICIAL_BASE_URL = "https://www.pflife.com.cn/"
FOSUN_PRUDENTIAL_PRODUCT_INFO_URL = "https://www.pflife.com.cn/fbofficialweb/basic?childmenu=ProductCatalog"
FOSUN_PRUDENTIAL_DOWNLOAD_BASE_URL = "https://www.pflife.com.cn/FBGWServer"
FOSUN_PRUDENTIAL_OFFICIAL_DOMAIN = "www.pflife.com.cn"
FOSUN_PRUDENTIAL_OFFICIAL_DOMAINS = {"pflife.com.cn", "www.pflife.com.cn"}
FOSUN_PRUDENTIAL_STATUS_PROFILES = {
    "ZS": {"salesStatus": "在售", "label": "在售产品"},
    "TS": {"salesStatus": "停售", "label": "停售产品"},
    "WKS": {"salesStatus": "已报备未销售", "label": "已报备未销售产品"},
}
FOSUN_UHI_PRODUCT_INFO_URL = "https://www.fosun-uhi.com/PublicInformation/BasicInformation/ProductInformation/"
FOSUN_UHI_PRODUCT_IFRAME_URL = "https://www.fosun-uhi.com/PublicInformation/BasicInformation/ProductInformation/iframe.html?v=20240712"
FOSUN_UHI_PRODUCT_ENDPOINT = "https://www.fosun-uhi.com/wj/shop/complaints_proposal_new!getProductInfor.action"
FOSUN_UHI_OFFICIAL_DOMAIN = "www.fosun-uhi.com"
FOSUN_UHI_OFFICIAL_DOMAINS = {"fosun-uhi.com", "www.fosun-uhi.com", "fosunuhi.com.cn", "www.fosunuhi.com.cn"}
FOSUN_UHI_STATUS_PROFILES = {
    "S:Y": {"salesStatus": "在售", "segment": "个人保险", "label": "在售个险"},
    "G:Y": {"salesStatus": "在售", "segment": "团体保险", "label": "在售团险"},
    "S:N": {"salesStatus": "停售", "segment": "个人保险", "label": "停售个险"},
    "G:N": {"salesStatus": "停售", "segment": "团体保险", "label": "停售团险"},
}
CITIC_PRUDENTIAL_PRODUCT_INFO_URL = "https://www.citic-prudential.com.cn/internetproductinformation/list.html"
CITIC_PRUDENTIAL_OFFICIAL_DOMAIN = "www.citic-prudential.com.cn"
CITIC_PRUDENTIAL_OFFICIAL_DOMAINS = {
    "citic-prudential.com.cn",
    "www.citic-prudential.com.cn",
    "gwoss.citic-prudential.citic",
    "ofcwbs-prd-bucket.oss-cn-beijing.aliyuncs.com",
}
BOB_CARDIF_PRODUCT_INFO_URL = "http://www.bob-cardif.com/xinxipilu/jibenxinxi/chanpinjibenxinxi/baoxianchanpinjibenxinxi/index.html"
BOB_CARDIF_OFFICIAL_BASE_URL = "http://www.bob-cardif.com/"
BOB_CARDIF_OFFICIAL_DOMAIN = "www.bob-cardif.com"
BOB_CARDIF_OFFICIAL_DOMAINS = {"bob-cardif.com", "www.bob-cardif.com"}
BOB_CARDIF_PRODUCT_PAGES = [
    {
        "url": "http://www.bob-cardif.com/xinxipilu/jibenxinxi/chanpinjibenxinxi/baoxianchanpinjibenxinxi/100002158385.html",
        "label": "在售产品",
        "salesStatus": "在售",
    },
    {
        "url": "http://www.bob-cardif.com/xinxipilu/jibenxinxi/chanpinjibenxinxi/baoxianchanpinjibenxinxi/100002158374.html",
        "label": "停售产品",
        "salesStatus": "停售",
    },
]
SUNLIFE_EVERBRIGHT_OFFICIAL_BASE_URL = "https://www.sunlife-everbright.com/"
SUNLIFE_EVERBRIGHT_OFFICIAL_DOMAIN = "www.sunlife-everbright.com"
SUNLIFE_EVERBRIGHT_PRODUCT_INFO_URL = "https://www.sunlife-everbright.com/sleb/info/jbxx/cpjbxx/jydbxcpmljtk/609782/index.html"
SUNLIFE_EVERBRIGHT_ARCHIVE_EXCLUDED_RE = re.compile(
    r"费率|保险费率|现金价值|现价|利益演示|账户价值|材料清单|清单|报送材料|备案报送|编码信息|精算师|声明书|法律责任人|责任人|批复|批单|变更原因|对比说明|投保规则|投保须知",
    re.I,
)
HENGQIN_LIFE_OFFICIAL_BASE_URL = "https://www.hqins.cn/"
HENGQIN_LIFE_PRODUCT_INFO_URL = "https://www.hqins.cn/OpenInfo/base_info/product_info"
HENGQIN_LIFE_API_BASE_URL = "https://www.hqins.cn/face"
HENGQIN_LIFE_OFFICIAL_DOMAIN = "www.hqins.cn"
HENGQIN_LIFE_OFFICIAL_DOMAINS = {"www.hqins.cn", "hqins.cn", "static.e-hqins.com", "oss-cn-szfinance.aliyuncs.com"}
HENGQIN_LIFE_PRODUCT_ARTICLES = {
    "in_sale": {"code": "3b581555eab3", "path": "product_up", "salesStatus": "在售", "label": "在售产品"},
    "stopped": {"code": "0a4b3b75db55", "path": "product_down", "salesStatus": "停售", "label": "停售产品"},
}
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
DINGCHENG_LIFE_OFFICIAL_BASE_URL = "https://www.dingchenglife.com.cn/"
DINGCHENG_LIFE_OFFICIAL_DOMAINS = {
    "dingchenglife.com.cn",
    "www.dingchenglife.com.cn",
    "dc-life.com.cn",
    "www.dc-life.com.cn",
}
DINGCHENG_LIFE_PRODUCT_PAGES = [
    {
        "key": "in_sale",
        "url": "https://www.dingchenglife.com.cn/gkxxpl/jbxx/zscpxx/",
        "label": "在售产品信息",
        "defaultSalesStatus": "在售",
    },
    {
        "key": "stopped",
        "url": "https://www.dingchenglife.com.cn/gkxxpl/jbxx/tscpxx/",
        "label": "停售产品信息",
        "defaultSalesStatus": "停售",
    },
    {
        "key": "internet",
        "url": "https://www.dingchenglife.com.cn/zxxx/hlwbx/",
        "label": "互联网保险信息披露",
        "defaultSalesStatus": "互联网保险披露",
    },
]
PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL = "https://www.pkufi.com/"
PKU_FOUNDER_LIFE_OFFICIAL_DOMAIN = "wechat.pkufi.com"
PKU_FOUNDER_LIFE_ASSET_DOMAIN = "web-package.oss-cn-shanghai.aliyuncs.com"
PKU_FOUNDER_LIFE_OFFICIAL_DOMAINS = {
    "www.pkufi.com",
    "pkufi.com",
    PKU_FOUNDER_LIFE_OFFICIAL_DOMAIN,
    PKU_FOUNDER_LIFE_ASSET_DOMAIN,
}
PKU_FOUNDER_LIFE_PRODUCT_INFO_URL = "https://www.pkufi.com/api/information/InformationProduct/list"
PKU_FOUNDER_LIFE_INTERNET_PRODUCT_URL = "https://www.pkufi.com/api/information/InformationProductInternet/page?page=1&limit=200"
PKU_FOUNDER_LIFE_TERMS = [
    {
        "productName": "北大方正人寿安行意外伤害保险",
        "productType": "意外险",
        "salesStatus": "公开披露",
        "title": "北大方正人寿保险有限公司安行意外伤害保险条款（2020年4月）",
        "url": "https://wechat.pkufi.com/pkufi/wechat/microservice/insuranceDonation/pdf/%E5%AE%89%E8%A1%8C%E6%84%8F%E5%A4%96%E4%BC%A4%E5%AE%B3%E4%BF%9D%E9%99%A9%E6%9D%A1%E6%AC%BE.pdf",
        "sourcePage": "https://www.pkufi.com/",
    },
    {
        "productName": "北大方正人寿银发康健老年恶性肿瘤疾病保险",
        "productType": "健康险",
        "salesStatus": "公开披露",
        "title": "北大方正人寿保险有限公司银发康健老年恶性肿瘤疾病保险条款",
        "url": "https://wechat.pkufi.com/pkufi/wechat/resources/js/vshop/rate/AEC--insuranceClause.pdf",
        "sourcePage": "https://www.pkufi.com/",
    },
]
SOOCHOW_LIFE_PRODUCT_INFO_URL = "https://www.soochowlife.net/eportal/ui?pageId=363297"
SOOCHOW_LIFE_OFFICIAL_DOMAIN = "www.soochowlife.net"
SOOCHOW_LIFE_OFFICIAL_DOMAINS = {"soochowlife.net", "www.soochowlife.net", "wx.e-soochowlife.com"}
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
RESPONSIBILITY_TOC_MARKER_RE = re.compile(r"(?<![\u4e00-\u9fff])目\s*录(?![\u4e00-\u9fff])|条款目录|阅读指引|阅\s*读\s*指\s*引|\.{3,}|…{2,}|……")
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


def extract_pdf_text_with_local_vision(data: bytes, max_pages: int = 0) -> dict[str, Any]:
    if not data:
        return {"pages": 0, "text": "", "error": "empty_pdf"}
    script_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "ocr-service", "scripts", "pdf_responsibility_vision.swift")
    )
    if not os.path.exists(script_path):
        return {"pages": 0, "text": "", "error": "vision_script_missing"}
    with tempfile.NamedTemporaryFile(prefix="policy-vision-", suffix=".pdf") as pdf_file:
        pdf_file.write(data)
        pdf_file.flush()
        proc = subprocess.run(
            ["swift", script_path, pdf_file.name, str(max_pages or 0)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=90,
        )
    if proc.returncode != 0:
        return {"pages": 0, "text": "", "error": proc.stderr.decode("utf-8", "ignore")[:300]}
    try:
        return json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return {"pages": 0, "text": "", "error": "vision_json_parse_failed"}


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
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
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
                        **archive_pdf_bytes(data_bytes, pdf_archive_dir, material_url),
                    }
                )
        page_meta["productCount"] = len(products)
        page_meta["recordCount"] = len(records)
        await browser.close()
        return {
            "ok": True,
            "company": company,
            "saleType": sale_type,
            "offset": offset,
            "maxProducts": max_products,
            "pages": [page_meta],
            "products": products,
            "records": records,
            "pdfArchiveDir": pdf_archive_dir,
            "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
        }


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
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
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
                    **archive_pdf_bytes(data_bytes, pdf_archive_dir, material_url),
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
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
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


def ping_an_loan_rate_product_type(value: str) -> str:
    product_name = trim(value)
    if "万能" in product_name:
        return "万能账户"
    if "投连" in product_name:
        return "投连险"
    if "重大疾病" in product_name or "疾病" in product_name:
        return "重疾险"
    if "医疗" in product_name:
        return "医疗险"
    if "年金" in product_name or "养老" in product_name or "教育" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "寿险" in product_name or "终身寿" in product_name or "终身保险" in product_name:
        return "寿险"
    return ""


def ping_an_parse_loan_rate_products(text: str) -> list[dict[str, Any]]:
    product_type_words = "普通型|分红型|万能型|投资连结型|投连型"
    row_re = re.compile(rf"^([0-9][0-9A-Za-z]*)\s+(.+?)\s+({product_type_words})\s+([0-9.]+%)?(?:\s+([0-9.]+%))?\s*$")
    name_re = re.compile(rf"^(.+?)\s+({product_type_words})\s+([0-9.]+%)?(?:\s+([0-9.]+%))?\s*$")
    products: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    pending_code = ""
    for raw_line in (text or "").splitlines():
        line = clean_text(raw_line)
        if not line or "产品代码" in line or "保单贷款利率" in line or "一览表" in line:
            continue
        if re.fullmatch(r"[0-9][0-9A-Za-z]*", line):
            pending_code = line
            continue
        match = row_re.match(line)
        if not match and pending_code:
            name_match = name_re.match(line)
            if name_match:
                match = (pending_code, *name_match.groups())
            pending_code = ""
        if not match:
            continue
        if isinstance(match, tuple):
            plan_code, product_name, official_product_type, loan_rate, self_pay_rate = match
        else:
            plan_code, product_name, official_product_type, loan_rate, self_pay_rate = match.groups()
        plan_code = trim(plan_code)
        if not plan_code or plan_code in seen_codes:
            continue
        seen_codes.add(plan_code)
        product_name = trim(product_name)
        products.append(
            {
                "planCode": plan_code,
                "productName": product_name,
                "productType": ping_an_loan_rate_product_type(product_name),
                "officialProductType": trim(official_product_type),
                "loanRate": trim(loan_rate),
                "selfPayRate": trim(self_pay_rate),
                "sourceUrl": PING_AN_LOAN_RATE_PDF_URL,
                "sourceName": "平安官网保单贷款利率表",
            }
        )
    return products


def crawl_ping_an_loan_rate_products(payload: dict[str, Any]) -> dict[str, Any]:
    status, data = fetch_bytes(PING_AN_LOAN_RATE_PDF_URL)
    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return {
            "ok": False,
            "company": trim(payload.get("company")) or "中国平安",
            "source": PING_AN_LOAN_RATE_PDF_URL,
            "code": "PING_AN_LOAN_RATE_PDF_UNAVAILABLE",
            "status": status,
            "bytes": len(data),
            "products": [],
        }
    extracted = extract_pdf_text_with_system_python(data)
    products = ping_an_parse_loan_rate_products(extracted.get("text", ""))
    return {
        "ok": True,
        "company": trim(payload.get("company")) or "中国平安",
        "source": PING_AN_LOAN_RATE_PDF_URL,
        "pages": extracted.get("pages", 0),
        "productCount": len(products),
        "products": products,
    }


def ping_an_history_seed_versions(seed: dict[str, Any], default_max_version: int) -> list[str]:
    plan_code = trim(seed.get("planCode"))
    if not plan_code:
        return []
    explicit_versions = seed.get("versions")
    if isinstance(explicit_versions, list):
        return [trim(item) for item in explicit_versions if trim(item)]
    max_version = max(1, int(seed.get("maxVersion") or default_max_version or 1))
    return [f"{plan_code}-{index}" for index in range(1, max_version + 1)]


def ping_an_historical_product_title(text: str) -> str:
    lines = []
    for raw_line in (text or "").splitlines():
        line = clean_text(raw_line)
        line = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", line)
        line = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[，,。：:；;、）)])", "", line)
        line = re.sub(r"(?<=[（(])\s+(?=[\u4e00-\u9fff])", "", line)
        if line:
            lines.append(line)
    for line in lines:
        if "平安" not in line or "条款" not in line:
            continue
        if any(keyword in line for keyword in ["阅读指引", "内容的解释", "条款目录", "本条款", "合同构成"]):
            continue
        match = re.search(r"(平安[^。；;]{2,100}?条款)\s*$", line)
        if match:
            return trim(match.group(1))
    return ""


def ping_an_historical_product_name(seed: dict[str, Any], text: str) -> str:
    seed_name = trim(seed.get("productName"))
    if seed_name:
        return seed_name
    title = ping_an_historical_product_title(text)
    if not title:
        return ""
    return trim(re.sub(r"\s*条款\s*$", "", title))


def ping_an_historical_product_type(product_name: str, seed: dict[str, Any]) -> str:
    seed_type = trim(seed.get("productType"))
    if seed_type:
        return seed_type
    if "万能" in product_name:
        return "万能账户"
    if "投连" in product_name:
        return "投连险"
    if "重大疾病" in product_name:
        return "重疾险"
    if "医疗" in product_name:
        return "医疗险"
    if "年金" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "寿险" in product_name or "终身寿" in product_name:
        return "寿险"
    return ""


def ping_an_pdf_unavailable_reason(data: bytes, content_type: str = "") -> str:
    error_text = data[:1024].decode("utf-8", "ignore") if data else ""
    if "31019888" in error_text or "人机检测" in error_text:
        return "human_verification_required"
    if "json" in content_type.lower() and ("CODE" in error_text or "MSG" in error_text):
        return "non_pdf_json_response"
    return "pdf_unavailable"


def truthy(value: Any) -> bool:
    return trim(value).lower() in {"1", "true", "yes", "y", "on"}


def resolve_pdf_archive_dir(payload: dict[str, Any]) -> str:
    explicit_dir = trim(payload.get("pdfArchiveDir")) or trim(os.environ.get("POLICY_PDF_ARCHIVE_DIR"))
    if explicit_dir:
        return os.path.abspath(os.path.expanduser(explicit_dir))
    if truthy(payload.get("archivePdf")) or truthy(os.environ.get("POLICY_PDF_ARCHIVE")):
        return DEFAULT_PDF_ARCHIVE_DIR
    return ""


def archive_pdf_bytes(data: bytes, archive_dir: str, source_url: str = "") -> dict[str, Any]:
    if not archive_dir or not data or not data.startswith(b"%PDF"):
        return {}
    sha256 = hashlib.sha256(data).hexdigest()
    target_dir = os.path.join(archive_dir, sha256[:2], sha256[2:4])
    target_path = os.path.join(target_dir, f"{sha256}.pdf")
    os.makedirs(target_dir, exist_ok=True)
    if not os.path.exists(target_path):
        temp_path = f"{target_path}.{uuid.uuid4().hex}.tmp"
        with open(temp_path, "wb") as handle:
            handle.write(data)
        os.replace(temp_path, target_path)
    return {
        "pdfLocalPath": target_path,
        "pdfSha256": sha256,
        "pdfBytes": len(data),
        "pdfOriginalUrl": trim(source_url),
        "pdfArchivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


async def ensure_jrcpcx_query_page(browser: Any) -> Any:
    for context in browser.contexts:
        for page in context.pages:
            if "jrcpcx.cn" in page.url:
                if "#/query" not in page.url:
                    await page.goto("https://www.jrcpcx.cn/#/query", wait_until="domcontentloaded", timeout=60000)
                return page
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    page = await context.new_page()
    await page.goto("https://www.jrcpcx.cn/#/query", wait_until="domcontentloaded", timeout=60000)
    return page


def jrcpcx_extract_list(data: Any) -> tuple[list[dict[str, Any]], int]:
    payload = data.get("data") if isinstance(data, dict) else data
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)], len(payload)
    if not isinstance(payload, dict):
        return [], 0
    for key in ("list", "records", "rows", "data"):
        rows = payload.get(key)
        if isinstance(rows, list):
            total = payload.get("total") or payload.get("totalShow") or payload.get("totalCount") or payload.get("count") or len(rows)
            return [item for item in rows if isinstance(item, dict)], int(total or 0)
    return [], int(payload.get("total") or payload.get("totalShow") or payload.get("totalCount") or 0)


def jrcpcx_catalog_id(row: dict[str, Any]) -> str:
    explicit = trim(row.get("id") or row.get("productId") or row.get("productCode") or row.get("industryCode"))
    if explicit:
        return f"jrcpcx_{explicit}"
    raw = json.dumps(row, ensure_ascii=False, sort_keys=True)
    return f"jrcpcx_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]}"


def jrcpcx_normalize_product(row: dict[str, Any], detail: dict[str, Any] | None = None) -> dict[str, Any]:
    detail_data = detail.get("data") if isinstance(detail, dict) and isinstance(detail.get("data"), dict) else {}
    merged = {**row, **detail_data}
    return {
        "catalogId": jrcpcx_catalog_id(row),
        "source": "https://www.jrcpcx.cn/#/query",
        "sourceLevel": "regulatory_industry_index",
        "productCategory": trim(merged.get("productCategory")) or "02",
        "productName": trim(merged.get("productName")),
        "industryCode": trim(merged.get("industryCode")),
        "deptName": trim(merged.get("deptName")),
        "productType": trim(merged.get("productType")),
        "productTerm": trim(merged.get("productTerm")),
        "productState": trim(merged.get("productState")),
        "status": trim(merged.get("status")),
        "rowId": trim(row.get("id")),
        "raw": row,
        "detail": detail_data,
    }


def jrcpcx_row_id_from_visible_row(row: dict[str, Any], query: str) -> str:
    raw = "|".join(
        [
            trim(query),
            trim(row.get("productName")),
            trim(row.get("deptName")),
            trim(row.get("productType")),
            trim(row.get("productState")),
        ]
    )
    return f"jrcpcx_ui_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]}"


def jrcpcx_visible_row_key(row: dict[str, Any]) -> str:
    return "|".join([trim(row.get("productName")), trim(row.get("deptName")), trim(row.get("productType")), trim(row.get("productState"))])


def jrcpcx_compact_text(value: Any) -> str:
    return "".join(trim(value).split())


def jrcpcx_visible_row_matches_query(
    row: dict[str, Any],
    dept_name: str,
    product_name: str,
    product_state_label: str = "",
) -> bool:
    row_dept = jrcpcx_compact_text(row.get("deptName"))
    row_product = jrcpcx_compact_text(row.get("productName"))
    row_state = jrcpcx_compact_text(row.get("productState"))
    query_dept = jrcpcx_compact_text(dept_name)
    query_product = jrcpcx_compact_text(product_name)
    query_state = jrcpcx_compact_text(product_state_label)
    if query_dept and query_dept not in row_dept:
        return False
    if query_product and query_product not in row_product:
        return False
    if query_state and query_state != "全部" and row_state != query_state:
        return False
    return True


def jrcpcx_detail_aes_decrypt(value: str) -> str:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    encrypted = base64.b64decode(trim(value).replace("_", "+"))
    cipher = Cipher(
        algorithms.AES(JRCPCX_DETAIL_AES_KEY.encode("utf-8")),
        modes.CBC(JRCPCX_DETAIL_AES_IV.encode("utf-8")),
        backend=default_backend(),
    )
    decryptor = cipher.decryptor()
    decoded = decryptor.update(encrypted) + decryptor.finalize()
    return decoded.decode("utf-8", "ignore").rstrip("\x00")


def jrcpcx_detail_aes_encrypt(value: str) -> str:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    data = value.encode("utf-8")
    pad_size = (16 - (len(data) % 16)) % 16
    if pad_size:
        data += b"\x00" * pad_size
    cipher = Cipher(
        algorithms.AES(JRCPCX_DETAIL_AES_KEY.encode("utf-8")),
        modes.CBC(JRCPCX_DETAIL_AES_IV.encode("utf-8")),
        backend=default_backend(),
    )
    encryptor = cipher.encryptor()
    encoded = encryptor.update(data) + encryptor.finalize()
    return base64.b64encode(encoded).decode("ascii").replace("+", "_")


def jrcpcx_detail_request(url: str, max_bytes: int = MAX_PDF_BYTES) -> tuple[int, str, bytes]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": f"{JRCPCX_DETAIL_BASE_URL}/lifeIns/detail",
            "Accept": "application/json,application/pdf,application/octet-stream,*/*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content_type = trim(response.headers.get("content-type"))
            return int(getattr(response, "status", 0) or 0), content_type, response.read(max_bytes + 1)
    except Exception:
        return 0, "", b""


def jrcpcx_detail_url_params(detail_url: str) -> dict[str, str]:
    params = parse_qs(urlsplit(detail_url).query)
    return {
        "data": trim((params.get("data") or [""])[0]),
        "dataId": trim((params.get("dataId") or [""])[0]),
        "channelof": trim((params.get("channelof") or [""])[0]),
    }


def jrcpcx_detail_data_map(data_list: list[dict[str, Any]]) -> dict[str, str]:
    mapped: dict[str, str] = {}
    for item in data_list:
        if not isinstance(item, dict):
            continue
        key = re.sub(r"[：:\s]+$", "", trim(item.get("key")))
        value = trim(item.get("value"))
        if key:
            mapped[key] = value
    return mapped


def normalize_jrcpcx_clause_url(value: str) -> str:
    url = trim(value)
    if not url:
        return ""
    parts = urlsplit(url)
    if parts.netloc != "inspdinfo.iachina.cn" or not parts.path.endswith("/prod-api/lifeIns/clauseInfo"):
        return ""
    params = []
    for key, values in parse_qs(parts.query, keep_blank_values=True).items():
        if key == "t":
            continue
        for item in values:
            params.append((key, item))
    params.sort()
    return urlunsplit((parts.scheme or "https", parts.netloc, parts.path, urlencode(params), ""))


def jrcpcx_fetch_life_ins_detail(
    product: dict[str, Any],
    pdf_archive_dir: str = "",
    skip_clause_urls: set[str] | None = None,
) -> dict[str, Any]:
    detail_url = trim(product.get("detailUrl"))
    if not detail_url:
        return {"ok": False, "code": "JRCPCX_DETAIL_URL_MISSING", "productName": trim(product.get("productName"))}
    params = jrcpcx_detail_url_params(detail_url)
    if not params.get("data") or not params.get("dataId"):
        return {"ok": False, "code": "JRCPCX_DETAIL_PARAMS_MISSING", "detailUrl": detail_url}
    detail_query = urlencode(
        {
            "data": params["data"],
            "dataId": params["dataId"],
            "time": str(int(time.time() * 1000)),
            "clientType": "02",
        }
    )
    detail_api_url = f"{JRCPCX_DETAIL_BASE_URL}/prod-api/lifeIns/detail?{detail_query}"
    status, content_type, body = jrcpcx_detail_request(detail_api_url)
    if status < 200 or status >= 300:
        return {"ok": False, "code": "JRCPCX_DETAIL_FETCH_FAILED", "status": status, "contentType": content_type, "detailUrl": detail_url}
    try:
        payload = json.loads(body.decode("utf-8", "ignore"))
    except Exception as error:
        return {"ok": False, "code": "JRCPCX_DETAIL_JSON_FAILED", "message": str(error)[:200], "detailUrl": detail_url}
    if int(payload.get("code") or 0) != 200:
        return {
            "ok": False,
            "code": "JRCPCX_DETAIL_API_FAILED",
            "message": trim(payload.get("msg")),
            "detailUrl": detail_url,
        }
    try:
        data_list = json.loads(jrcpcx_detail_aes_decrypt(payload.get("data") or ""))
        file_name = json.loads(jrcpcx_detail_aes_decrypt(payload.get("dataKey") or ""))
    except Exception as error:
        return {"ok": False, "code": "JRCPCX_DETAIL_DECRYPT_FAILED", "message": str(error)[:200], "detailUrl": detail_url}
    fields = jrcpcx_detail_data_map(data_list if isinstance(data_list, list) else [])
    info = jrcpcx_detail_aes_encrypt(json.dumps({"fileName": file_name, "pageSize": 1, "fileType": "01", "clientType": "02"}, ensure_ascii=False))
    clause_url = f"{JRCPCX_DETAIL_BASE_URL}/prod-api/lifeIns/clauseInfo?{urlencode({'info': info, 't': str(int(time.time() * 1000))})}"
    product_name = trim(fields.get("产品名称")) or trim(product.get("productName"))
    company = trim(fields.get("公司名称")) or trim(product.get("deptName"))
    if normalize_jrcpcx_clause_url(clause_url) in (skip_clause_urls or set()):
        record = {
            "company": company,
            "productName": product_name,
            "productType": trim(fields.get("产品类别")) or trim(product.get("productType")),
            "salesStatus": trim(fields.get("产品销售状态")) or trim(product.get("productState")),
            "title": f"{product_name}条款" if product_name else "保险条款",
            "url": detail_url,
            "source": detail_url,
            "sourceUrl": detail_url,
            "sourceLevel": "regulatory_industry_terms",
            "officialDomain": "inspdinfo.iachina.cn",
            "materialType": "terms",
            "parser": "jrcpcx_life_ins_detail",
            "pageText": "",
            "qualityStatus": "represented_local_url",
            "snippet": "本地库已存在同一 JRCPCX 条款 URL，跳过重复 PDF 下载。",
            "detailUrl": detail_url,
            "detailApiUrl": detail_api_url,
            "clauseFileName": trim(file_name),
            "clauseUrl": clause_url,
            "detailFields": fields,
        }
        return {
            "ok": True,
            "skippedExisting": True,
            "productName": product_name,
            "company": company,
            "detailUrl": detail_url,
            "fields": fields,
            "fileName": file_name,
            "record": record,
        }
    pdf_status, pdf_content_type, pdf_bytes = jrcpcx_detail_request(clause_url)
    if pdf_status < 200 or pdf_status >= 300 or not pdf_bytes.startswith(b"%PDF"):
        return {
            "ok": False,
            "code": "JRCPCX_CLAUSE_PDF_FETCH_FAILED",
            "status": pdf_status,
            "contentType": pdf_content_type,
            "bytes": len(pdf_bytes),
            "detailUrl": detail_url,
            "fields": fields,
        }
    extracted = extract_pdf_text_with_system_python(pdf_bytes)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    archive = archive_pdf_bytes(pdf_bytes, pdf_archive_dir, clause_url) if pdf_archive_dir else {}
    record = {
        "company": company,
        "productName": product_name,
        "productType": trim(fields.get("产品类别")) or trim(product.get("productType")),
        "salesStatus": trim(fields.get("产品销售状态")) or trim(product.get("productState")),
        "title": f"{product_name}条款" if product_name else "保险条款",
        "url": detail_url,
        "source": detail_url,
        "sourceUrl": detail_url,
        "sourceLevel": "regulatory_industry_terms",
        "officialDomain": "inspdinfo.iachina.cn",
        "materialType": "terms",
        "parser": "jrcpcx_life_ins_detail",
        "pageText": page_text,
        "qualityStatus": "valid_complete" if page_text else "invalid_empty",
        "snippet": "金融产品查询平台/中国保险行业协会条款 PDF，已截取保险责任正文段。" if page_text else "",
        "detailUrl": detail_url,
        "detailApiUrl": detail_api_url,
        "clauseFileName": trim(file_name),
        "clauseUrl": clause_url,
        "pages": extracted.get("pages", 0),
        "bytes": len(pdf_bytes),
        "contentType": pdf_content_type,
        "detailFields": fields,
        **archive,
    }
    return {
        "ok": True,
        "productName": product_name,
        "company": company,
        "detailUrl": detail_url,
        "fields": fields,
        "fileName": file_name,
        "record": record,
    }


async def jrcpcx_visible_table_rows(page: Any) -> list[dict[str, Any]]:
    rows = await page.evaluate(
        """() => {
          const parsed = [];
          const trs = Array.from(document.querySelectorAll('.el-table__body-wrapper > table > tbody > tr.el-table__row'))
            .filter((tr) => tr.querySelector(':scope > td.el-table__expand-column .el-table__expand-icon'));
          for (const tr of trs) {
            const cells = Array.from(tr.querySelectorAll(':scope > td'))
              .map((td) => (td.innerText || '').trim());
            if (cells.length < 5) continue;
            parsed.push({
              index: cells[0],
              productName: cells[1],
              deptName: cells[2],
              productType: cells[3],
              productState: cells[4],
            });
          }
          return parsed;
        }"""
    )
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        key = jrcpcx_visible_row_key(row)
        if not trim(row.get("productName")) or key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def jrcpcx_table_rows_signature(rows: list[dict[str, Any]]) -> str:
    return "\n".join(jrcpcx_visible_row_key(row) for row in rows)


async def jrcpcx_visible_table_detail_links(page: Any) -> dict[str, dict[str, Any]]:
    result = await page.evaluate(
        """async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const output = {};
          const rowKey = (row) => [row.productName, row.deptName, row.productType, row.productState]
            .map((item) => (item || '').trim())
            .join('|');
          const parseMainRow = (tr) => {
            const cells = Array.from(tr.querySelectorAll(':scope > td'))
              .map((td) => (td.innerText || '').trim());
            return {
              index: cells[0] || '',
              productName: cells[1] || '',
              deptName: cells[2] || '',
              productType: cells[3] || '',
              productState: cells[4] || '',
            };
          };
          const parseExpandedRow = (tr) => {
            const expanded = tr.nextElementSibling;
            if (!expanded || !expanded.querySelector('.el-table__expanded-cell')) return {};
            const detailCells = Array.from(expanded.querySelectorAll('.sub-table .el-table__body-wrapper tbody tr:first-child td'))
              .map((td) => (td.innerText || '').trim())
              .filter(Boolean);
            const detailLink = expanded.querySelector('.sub-table .el-table__body-wrapper tbody tr:first-child a[href*="/lifeIns/"], .sub-table .el-table__body-wrapper tbody tr:first-child a[href*="/propertyIns/"]');
            return {
              productTerm: detailCells[0] || '',
              industryCode: detailCells[1] || '',
              infoSource: detailCells[2] || '',
              detailText: detailCells[3] || '',
              detailUrl: detailLink ? detailLink.href : '',
            };
          };
          const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper > table > tbody > tr.el-table__row'))
            .filter((tr) => tr.querySelector(':scope > td.el-table__expand-column .el-table__expand-icon'));
          for (const tr of rows) {
            const row = parseMainRow(tr);
            if (!row.productName) continue;
            const icon = tr.querySelector(':scope > td.el-table__expand-column .el-table__expand-icon');
            const wasExpanded = icon && icon.classList.contains('el-table__expand-icon--expanded');
            if (icon && !wasExpanded) {
              icon.click();
              await sleep(350);
            }
            output[rowKey(row)] = parseExpandedRow(tr);
            if (icon && !wasExpanded && icon.classList.contains('el-table__expand-icon--expanded')) {
              icon.click();
              await sleep(100);
            }
          }
          return output;
        }"""
    )
    return result if isinstance(result, dict) else {}


async def jrcpcx_fill_text_input(page: Any, placeholder: str, value: str) -> None:
    locator = page.locator(f'input[placeholder="{placeholder}"]').first
    await locator.fill("")
    if value:
        await locator.fill(value)


async def jrcpcx_click_filter_option(page: Any, section_title: str, label: str) -> bool:
    option_label = trim(label) or "全部"
    target = await page.evaluate(
        """({sectionTitle, optionLabel}) => {
          const sections = Array.from(document.querySelectorAll('.list-sub'));
          const section = sections.find((item) => (item.innerText || '').includes(sectionTitle));
          if (!section) return null;
          const options = Array.from(section.querySelectorAll('li'))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                text: (el.innerText || '').trim(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            })
            .filter((item) => item.text === optionLabel && item.width > 0 && item.height > 0);
          return options[0] || null;
        }""",
        {"sectionTitle": section_title, "optionLabel": option_label},
    )
    if not target:
        return False
    await page.mouse.click(target["x"] + target["width"] / 2, target["y"] + target["height"] / 2)
    await page.wait_for_timeout(500)
    return True


async def jrcpcx_set_visible_page_size(page: Any, page_size: int) -> None:
    if page_size not in {10, 20, 50}:
        return
    boxes = await page.evaluate(
        """() => Array.from(document.querySelectorAll('.el-pagination .el-select input')).map((el) => {
          const rect = el.getBoundingClientRect();
          return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, value: el.value || ''};
        })"""
    )
    visible = next((box for box in boxes if box.get("width", 0) > 0 and box.get("height", 0) > 0), None)
    if not visible:
        return
    await page.mouse.click(visible["x"] + visible["width"] / 2, visible["y"] + visible["height"] / 2)
    await page.wait_for_timeout(300)
    label = f"{page_size}条/页"
    options = await page.evaluate(
        """(label) => Array.from(document.querySelectorAll('.el-select-dropdown__item')).map((el) => {
          const rect = el.getBoundingClientRect();
          return {text: (el.innerText || '').trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        }).filter((item) => item.text === label && item.width > 0 && item.height > 0)""",
        label,
    )
    if not options:
        return
    option = options[-1]
    await page.mouse.click(option["x"] + option["width"] / 2, option["y"] + option["height"] / 2)
    await page.wait_for_timeout(1000)


async def jrcpcx_click_visible_next_page(page: Any, previous_signature: str = "") -> bool:
    buttons = await page.evaluate(
        """() => Array.from(document.querySelectorAll('.el-pagination button.btn-next')).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            disabled: el.disabled || el.classList.contains('disabled'),
          };
        })"""
    )
    visible = next((button for button in buttons if button.get("width", 0) > 0 and button.get("height", 0) > 0 and not button.get("disabled")), None)
    if not visible:
        return False
    await page.mouse.click(visible["x"] + visible["width"] / 2, visible["y"] + visible["height"] / 2)
    deadline = time.time() + 6
    while time.time() < deadline:
        await page.wait_for_timeout(500)
        rows = await jrcpcx_visible_table_rows(page)
        if rows and (not previous_signature or jrcpcx_table_rows_signature(rows) != previous_signature):
            return True
    return False


async def jrcpcx_click_query_button(page: Any, timeout_ms: int = 20000) -> bool:
    deadline = time.time() + max(1, timeout_ms / 1000)
    while time.time() < deadline:
        target = await page.evaluate(
            """() => {
              const elements = Array.from(document.querySelectorAll('button, span, div'));
              const matches = elements
                .filter((el) => (el.innerText || '').trim() === '查询')
                .map((el) => {
                  const button = el.closest('button') || el;
                  const rect = button.getBoundingClientRect();
                  const className = button.className || '';
                  return {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    disabled:
                      Boolean(button.disabled) ||
                      button.getAttribute('aria-disabled') === 'true' ||
                      String(className).includes('is-disabled') ||
                      String(className).includes('disabled'),
                  };
                })
                .filter((item) => item.width > 0 && item.height > 0);
              return matches[0] || null;
            }"""
        )
        if target and not target.get("disabled"):
            await page.mouse.click(target["x"] + target["width"] / 2, target["y"] + target["height"] / 2)
            await page.wait_for_timeout(300)
            return True
        await page.wait_for_timeout(500)
    return False


async def jrcpcx_query_visible_page(
    page: Any,
    query: dict[str, Any],
    wait_ms: int,
    max_pages: int = 1,
    fetch_detail_links: bool = False,
) -> dict[str, Any]:
    dept_name = trim(query.get("deptName") or query.get("query") or query.get("company"))
    product_name = trim(query.get("productName"))
    industry_code = trim(query.get("industryCode"))
    product_type_label = trim(query.get("productTypeLabel")) or "全部"
    product_term_label = trim(query.get("productTermLabel")) or "全部"
    product_state_label = trim(query.get("productStateLabel")) or "全部"
    await jrcpcx_click_filter_option(page, "品类", "保险产品")
    await jrcpcx_click_filter_option(page, "产品类型", product_type_label)
    await jrcpcx_click_filter_option(page, "产品期限", product_term_label)
    await jrcpcx_click_filter_option(page, "产品状态", product_state_label)
    await jrcpcx_fill_text_input(page, "请输入产品名称", product_name)
    await jrcpcx_fill_text_input(page, "请输入行业编码", industry_code)
    await jrcpcx_fill_text_input(page, "请输入发行机构全称", dept_name)
    before_text = await page.locator("body").inner_text(timeout=5000)
    if not await jrcpcx_click_query_button(page, timeout_ms=max(20000, wait_ms)):
        body_text = await page.locator("body").inner_text(timeout=5000)
        return {
            "queryDeptName": dept_name,
            "productName": product_name,
            "industryCode": industry_code,
            "productTypeLabel": product_type_label,
            "productTermLabel": product_term_label,
            "productStateLabel": product_state_label,
            "rowCount": 0,
            "pageCount": 0,
            "truncated": "查询结果超过100条" in body_text,
            "verificationVisible": "请完成安全验证" in body_text or "向右拖动滑块" in body_text,
            "queryButtonDisabled": True,
            "products": [],
        }
    deadline = time.time() + max(5, wait_ms / 1000)
    last_text = before_text
    while time.time() < deadline:
        await page.wait_for_timeout(1000)
        last_text = await page.locator("body").inner_text(timeout=5000)
        rows = await jrcpcx_visible_table_rows(page)
        has_query_match = any(jrcpcx_visible_row_matches_query(row, dept_name, product_name, product_state_label) for row in rows)
        if rows and has_query_match:
            break
        if "请完成安全验证" in last_text or "向右拖动滑块" in last_text:
            continue
        if "暂无数据" in last_text and not rows:
            break
    rows = [
        row
        for row in await jrcpcx_visible_table_rows(page)
        if jrcpcx_visible_row_matches_query(row, dept_name, product_name, product_state_label)
    ]
    body_text = await page.locator("body").inner_text(timeout=5000)
    products = []
    seen_keys: set[str] = set()
    page_count = 0
    while True:
        page_count += 1
        detail_by_key = await jrcpcx_visible_table_detail_links(page) if fetch_detail_links else {}
        for row in rows:
            key = jrcpcx_visible_row_key(row)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            detail_info = detail_by_key.get(key) if isinstance(detail_by_key.get(key), dict) else {}
            products.append(
                {
                    "catalogId": jrcpcx_row_id_from_visible_row(row, dept_name),
                    "source": "https://www.jrcpcx.cn/#/query",
                    "sourceLevel": "regulatory_industry_index",
                    "queryDeptName": dept_name,
                    "queryProductType": product_type_label,
                    "queryProductTerm": product_term_label,
                    "queryProductState": product_state_label,
                    "pageNumber": page_count,
                    "productName": trim(row.get("productName")),
                    "deptName": trim(row.get("deptName")),
                    "productType": trim(row.get("productType")),
                    "productState": trim(row.get("productState")),
                    "productTerm": trim(detail_info.get("productTerm")),
                    "industryCode": trim(detail_info.get("industryCode")),
                    "infoSource": trim(detail_info.get("infoSource")),
                    "detailUrl": trim(detail_info.get("detailUrl")),
                    "raw": row,
                }
            )
        if page_count >= max(1, max_pages):
            break
        clicked = await jrcpcx_click_visible_next_page(page, previous_signature=jrcpcx_table_rows_signature(rows))
        if not clicked:
            break
        next_rows = [
            row
            for row in await jrcpcx_visible_table_rows(page)
            if jrcpcx_visible_row_matches_query(row, dept_name, product_name, product_state_label)
        ]
        if not next_rows:
            break
        rows = next_rows
    return {
        "queryDeptName": dept_name,
        "productName": product_name,
        "industryCode": industry_code,
        "productTypeLabel": product_type_label,
        "productTermLabel": product_term_label,
        "productStateLabel": product_state_label,
        "rowCount": len(products),
        "pageCount": page_count,
        "truncated": "查询结果超过100条" in body_text,
        "verificationVisible": "请完成安全验证" in body_text or "向右拖动滑块" in body_text,
        "products": products,
    }


async def crawl_jrcpcx_insurance_catalog_ui_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "products": []}
    cdp_url = trim(payload.get("cdpUrl")) or "http://127.0.0.1:9224"
    wait_ms = max(5000, int(payload.get("waitMs") or 120000))
    page_size = max(10, min(50, int(payload.get("pageSize") or 50)))
    max_pages = max(1, int(payload.get("maxPages") or 1))
    fetch_detail_links = trim(payload.get("fetchDetailLinks")).lower() in {"1", "true", "yes"}
    extract_responsibility = trim(payload.get("extractResponsibility")).lower() in {"1", "true", "yes"}
    detail_limit = max(0, int(payload.get("maxDetailProducts") or 0))
    pdf_archive_dir = resolve_pdf_archive_dir(payload) if extract_responsibility else ""
    queries = payload.get("queries") if isinstance(payload.get("queries"), list) else []
    if not queries:
        dept_names = payload.get("deptNames") if isinstance(payload.get("deptNames"), list) else []
        queries = [
            {
                "deptName": item,
                "productName": trim(payload.get("productName")),
                "industryCode": trim(payload.get("industryCode")),
            }
            for item in dept_names
        ]
    if not queries:
        single_dept = trim(payload.get("deptName"))
        single_product = trim(payload.get("productName"))
        single_industry_code = trim(payload.get("industryCode"))
        queries = [{"deptName": single_dept, "productName": single_product, "industryCode": single_industry_code}] if (single_dept or single_product or single_industry_code) else []
    if not queries:
        return {"ok": False, "code": "JRCPCX_QUERY_FIELD_REQUIRED", "message": "缺少发行机构/产品名/行业编码查询条件。", "products": []}
    products = []
    query_results = []
    partial_code = ""
    partial_message = ""
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        page = await ensure_jrcpcx_query_page(browser)
        await jrcpcx_set_visible_page_size(page, page_size)
        for query in queries:
            result = await jrcpcx_query_visible_page(page, query, wait_ms, max_pages=max_pages, fetch_detail_links=fetch_detail_links or extract_responsibility)
            query_results.append({k: v for k, v in result.items() if k != "products"})
            products.extend(result.get("products") or [])
            if result.get("queryButtonDisabled"):
                partial_code = "JRCPCX_QUERY_BUTTON_DISABLED"
                partial_message = "页面查询按钮持续不可用，请检查发行机构字段是否被页面接受，或刷新监管平台查询页后重试。"
                break
            if result.get("verificationVisible") and not result.get("products"):
                partial_code = "JRCPCX_VERIFICATION_REQUIRED"
                partial_message = "页面仍显示行为验证码，请在浏览器完成滑块后重试。"
                break
        await browser.close()
    records = []
    detail_results = []
    if extract_responsibility:
        seen_detail_urls: set[str] = set()
        extractable_products = [product for product in products if trim(product.get("detailUrl"))]
        if detail_limit:
            extractable_products = extractable_products[:detail_limit]
        for product in extractable_products:
            detail_url = trim(product.get("detailUrl"))
            if detail_url in seen_detail_urls:
                continue
            seen_detail_urls.add(detail_url)
            detail_result = jrcpcx_fetch_life_ins_detail(product, pdf_archive_dir)
            detail_results.append({k: v for k, v in detail_result.items() if k != "record"})
            record = detail_result.get("record") if isinstance(detail_result, dict) else None
            if isinstance(record, dict):
                records.append(record)
    return {
        "ok": True,
        "partial": bool(partial_code),
        "code": partial_code,
        "message": partial_message,
        "source": "https://www.jrcpcx.cn/#/query",
        "sourceLevel": "regulatory_industry_index",
        "cdpUrl": cdp_url,
        "queryCount": len(queries),
        "pageSize": page_size,
        "maxPages": max_pages,
        "productCount": len(products),
        "recordCount": len(records),
        "responsibilityCount": sum(1 for record in records if trim(record.get("pageText"))),
        "pdfArchiveDir": pdf_archive_dir,
        "queries": query_results,
        "detailResults": detail_results,
        "records": records,
        "products": products,
    }


def crawl_jrcpcx_insurance_catalog_ui(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(crawl_jrcpcx_insurance_catalog_ui_async(payload))


async def crawl_jrcpcx_insurance_catalog_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "products": []}
    cdp_url = trim(payload.get("cdpUrl")) or "http://127.0.0.1:9224"
    page_size = max(1, min(100, int(payload.get("pageSize") or 50)))
    max_pages = max(1, int(payload.get("maxPages") or 1))
    start_page = max(1, int(payload.get("startPage") or 1))
    fetch_details = not (trim(payload.get("fetchDetails")).lower() in {"0", "false", "no"})
    product_state = trim(payload.get("productState")) or "00"
    product_type = trim(payload.get("productType")) or "00"
    product_term = trim(payload.get("productTerm")) or "00"
    product_name = trim(payload.get("productName"))
    industry_code = trim(payload.get("industryCode"))
    dept_name = trim(payload.get("deptName"))
    products = []
    pages = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        page = await ensure_jrcpcx_query_page(browser)
        region_result = await browser_fetch_json(page, "/query/pc/getRegion", {})
        region_data = region_result.get("data") if isinstance(region_result.get("data"), dict) else {}
        region = trim(payload.get("region")) or trim(region_data.get("region")) or "330000"
        for page_no in range(start_page, start_page + max_pages):
            request_payload = {
                "productName": product_name,
                "industryCode": industry_code,
                "deptName": dept_name,
                "page": page_no,
                "size": page_size,
                "status": 1,
                "region": region,
                "productCategory": "02",
                "raiseWay": "00",
                "productType": product_type,
                "productTerm": product_term,
                "productState": product_state,
                "productMessage": "custom01",
            }
            response = await browser_fetch_json(page, "/query/pc/advanced", request_payload)
            data = response.get("data") if isinstance(response.get("data"), dict) else {}
            code = data.get("code") if isinstance(data, dict) else None
            msg = trim(data.get("msg") or data.get("message")) if isinstance(data, dict) else ""
            if code == 700 or "验证码" in msg:
                await browser.close()
                return {
                    "ok": False,
                    "code": "JRCPCX_VERIFICATION_REQUIRED",
                    "message": msg or "金融产品查询平台返回行为验证码，需要先在浏览器完成滑块验证。",
                    "cdpUrl": cdp_url,
                    "page": page_no,
                    "request": request_payload,
                    "products": products,
                    "pages": pages,
                }
            if code not in (None, 200):
                await browser.close()
                return {
                    "ok": False,
                    "code": "JRCPCX_QUERY_FAILED",
                    "message": msg or "金融产品查询平台列表接口返回失败。",
                    "cdpUrl": cdp_url,
                    "status": response.get("status"),
                    "responseCode": code,
                    "page": page_no,
                    "request": request_payload,
                    "response": data,
                    "products": products,
                    "pages": pages,
                }
            rows, total = jrcpcx_extract_list(data)
            page_meta = {
                "page": page_no,
                "size": page_size,
                "status": response.get("status"),
                "total": total,
                "rowCount": len(rows),
            }
            pages.append(page_meta)
            if not rows:
                break
            for row in rows:
                detail = {}
                row_id = trim(row.get("id"))
                if fetch_details and row_id:
                    detail_response = await browser_fetch_json(page, "/query/pc/info", {"id": row_id, "region": region})
                    detail = detail_response.get("data") if isinstance(detail_response.get("data"), dict) else {}
                products.append(jrcpcx_normalize_product(row, detail))
            if len(rows) < page_size:
                break
        await browser.close()
    return {
        "ok": True,
        "source": "https://www.jrcpcx.cn/#/query",
        "sourceLevel": "regulatory_industry_index",
        "cdpUrl": cdp_url,
        "region": region,
        "startPage": start_page,
        "pageSize": page_size,
        "maxPages": max_pages,
        "pageCount": len(pages),
        "productCount": len(products),
        "pages": pages,
        "products": products,
    }


def crawl_jrcpcx_insurance_catalog(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(crawl_jrcpcx_insurance_catalog_async(payload))


def ping_an_historical_record_from_pdf(
    company: str,
    seed: dict[str, Any],
    plan_code: str,
    version_no: str,
    material_url: str,
    data: bytes,
    content_type: str = "",
    pdf_archive_dir: str = "",
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    extracted = extract_pdf_text_with_system_python(data)
    full_text = trim(extracted.get("text"))
    product_name = ping_an_historical_product_name(seed, full_text)
    page_text = focused_responsibility_excerpt(full_text)
    if not product_name or not page_text:
        return None, None, {
            "planCode": plan_code,
            "versionNo": version_no,
            "url": material_url,
            "status": 200,
            "contentType": content_type,
            "bytes": len(data),
            "reason": "missing_product_name_or_responsibility",
        }
    product_type = ping_an_historical_product_type(product_name, seed)
    title = ping_an_historical_product_title(full_text) or f"{product_name}条款"
    record = {
        "company": company,
        "productName": product_name,
        "productType": product_type,
        "salesStatus": trim(seed.get("salesStatus")) or "停售（目录外历史产品）",
        "title": title,
        "url": material_url,
        "snippet": "平安官网历史目录外官方条款 PDF，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": "terms",
        "official": True,
        "evidenceLabel": "平安官网历史官方条款",
        "evidenceLevel": "insurer_official",
        "officialDomain": "life.pingan.com",
        "parser": "scrapling_ping_an_historical_seed",
        "qualityStatus": "valid_complete",
        "qualityReason": "official_pdf_seed_verified",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "planCode": plan_code,
        "versionNo": version_no,
        "catalogStatus": "missing_from_getProductList",
        "seedSource": trim(seed.get("seedSource")),
        "seedSourceUrl": trim(seed.get("seedSourceUrl")),
        **archive_pdf_bytes(data, pdf_archive_dir, material_url),
    }
    product = {
        "company": company,
        "productName": product_name,
        "productType": product_type,
        "salesStatus": trim(seed.get("salesStatus")) or "停售（目录外历史产品）",
        "sourcePage": trim(seed.get("seedSourceUrl")),
        "planCode": plan_code,
        "versionNo": version_no,
    }
    return record, product, None


def crawl_ping_an_historical_seed(payload: dict[str, Any]) -> dict[str, Any]:
    if trim(payload.get("cdpUrl")):
        return asyncio.run(crawl_ping_an_historical_seed_browser_async(payload))
    company = trim(payload.get("company")) or "中国平安"
    seeds = payload.get("seeds") if isinstance(payload.get("seeds"), list) else []
    default_max_version = max(1, int(payload.get("maxVersion") or 3))
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
    records = []
    skipped = []
    products = []
    seen_urls = set()
    for seed in seeds:
        plan_code = trim(seed.get("planCode"))
        if not plan_code:
            skipped.append({"reason": "missing_plan_code", "seed": seed})
            continue
        for version_no in ping_an_history_seed_versions(seed, default_max_version):
            material_url = ping_an_material_url(plan_code, version_no, "1")
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            status, data = fetch_bytes(material_url)
            if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
                skipped.append(
                    {
                        "planCode": plan_code,
                        "versionNo": version_no,
                        "url": material_url,
                        "status": status,
                        "bytes": len(data),
                        "reason": ping_an_pdf_unavailable_reason(data),
                    }
                )
                continue
            record, product, skip = ping_an_historical_record_from_pdf(
                company,
                seed,
                plan_code,
                version_no,
                material_url,
                data,
                pdf_archive_dir=pdf_archive_dir,
            )
            if skip:
                skipped.append(skip)
                continue
            records.append(record)
            products.append(product)
    return {
        "ok": True,
        "company": company,
        "seedCount": len(seeds),
        "productCount": len(products),
        "recordCount": len(records),
        "skippedCount": len(skipped),
        "products": products,
        "records": records,
        "skipped": skipped,
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


async def crawl_ping_an_historical_seed_browser_async(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except Exception as error:
        return {"ok": False, "code": "PLAYWRIGHT_NOT_AVAILABLE", "message": str(error), "records": []}
    company = trim(payload.get("company")) or "中国平安"
    seeds = payload.get("seeds") if isinstance(payload.get("seeds"), list) else []
    default_max_version = max(1, int(payload.get("maxVersion") or 3))
    cdp_url = trim(payload.get("cdpUrl")) or "http://127.0.0.1:9223"
    delay_ms = max(0, int(payload.get("delayMs") or 0))
    pdf_retry_count = max(0, int(payload.get("pdfRetryCount") or 0))
    pdf_retry_delay_ms = max(0, int(payload.get("pdfRetryDelayMs") or 0))
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
    records = []
    products = []
    skipped = []
    seen_urls = set()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        page = await ensure_ping_an_product_page(browser)
        for seed in seeds:
            plan_code = trim(seed.get("planCode"))
            if not plan_code:
                skipped.append({"reason": "missing_plan_code", "seed": seed})
                continue
            for version_no in ping_an_history_seed_versions(seed, default_max_version):
                material_url = ping_an_material_url(plan_code, version_no, "1")
                if material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                pdf_status, content_type, data_bytes = 0, "", b""
                for attempt in range(pdf_retry_count + 1):
                    pdf_status, content_type, data_bytes = await browser_fetch_bytes(page, material_url)
                    if data_bytes.startswith(b"%PDF"):
                        break
                    should_retry = (
                        attempt < pdf_retry_count
                        and pdf_status == 200
                        and "json" in content_type.lower()
                        and len(data_bytes) <= 2048
                    )
                    if not should_retry:
                        break
                    await asyncio.sleep((pdf_retry_delay_ms or 3000) / 1000)
                if pdf_status < 200 or pdf_status >= 300 or len(data_bytes) > MAX_PDF_BYTES or not data_bytes.startswith(b"%PDF"):
                    skipped.append(
                        {
                            "planCode": plan_code,
                            "versionNo": version_no,
                            "url": material_url,
                            "status": pdf_status,
                            "contentType": content_type,
                            "bytes": len(data_bytes),
                            "reason": ping_an_pdf_unavailable_reason(data_bytes, content_type),
                        }
                    )
                    if delay_ms:
                        await asyncio.sleep(delay_ms / 1000)
                    continue
                record, product, skip = ping_an_historical_record_from_pdf(
                    company,
                    seed,
                    plan_code,
                    version_no,
                    material_url,
                    data_bytes,
                    content_type,
                    pdf_archive_dir,
                )
                if skip:
                    skipped.append(skip)
                    if delay_ms:
                        await asyncio.sleep(delay_ms / 1000)
                    continue
                records.append(record)
                products.append(product)
                if delay_ms:
                    await asyncio.sleep(delay_ms / 1000)
        await browser.close()
    return {
        "ok": True,
        "company": company,
        "seedCount": len(seeds),
        "productCount": len(products),
        "recordCount": len(records),
        "skippedCount": len(skipped),
        "products": products,
        "records": records,
        "skipped": skipped,
        "cdpUrl": cdp_url,
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


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


def zhongan_product_type(title: str, fallback: str) -> str:
    text = trim(title)
    labels: list[str] = []
    if "医疗" in text or "住院" in text or "门急诊" in text or "齿科" in text:
        labels.append("医疗险")
    if "重大疾病" in text or "特定疾病" in text or "疾病" in text or "防癌" in text or "恶性肿瘤" in text:
        labels.append("重疾险")
    if "意外" in text or "伤害" in text:
        labels.append("意外险")
    if not labels and fallback:
        labels.append(fallback)
    return "、".join(dict.fromkeys(label for label in labels if label)) or "其他"


def zhongan_product_name_from_title(title: str) -> str:
    text = trim(title)
    text = re.sub(r"^众安在线财产保险股份有限公司", "", text)
    text = re.sub(r"(?:条款|保险条款)(?:（[^）]*）)?$", "", text)
    return trim(text) or trim(title)


def zhongan_material_tasks(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    page_limit = max(0, int(payload.get("maxPages") or 0))
    product_offset = max(0, int(payload.get("productOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    pages = ZHONGAN_PRODUCT_PAGES[:page_limit] if page_limit else ZHONGAN_PRODUCT_PAGES
    tasks: list[dict[str, Any]] = []
    page_results: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for page_info in pages:
        page_url = urljoin(ZHONGAN_PRODUCT_INFO_URL, page_info["path"])
        status, html = fetch_html_direct(page_url, referer=ZHONGAN_PRODUCT_INFO_URL)
        page_results.append({"url": page_url, "label": page_info["label"], "status": status})
        if status < 200 or status >= 300 or not html:
            continue
        soup = BeautifulSoup(html, "html.parser")
        for link in soup.find_all("a", href=True):
            title = clean_text(link.get_text(" "))
            material_url = urljoin(page_url, trim(link.get("href")))
            if not title or material_url in seen_urls:
                continue
            if ".pdf" not in material_url.lower():
                continue
            if "条款" not in title or EXCLUDED_MATERIAL_RE.search(title):
                continue
            host = urlsplit(material_url).hostname or ""
            if host not in {ZHONGAN_STATIC_DOMAIN, ZHONGAN_OFFICIAL_DOMAIN}:
                continue
            seen_urls.add(material_url)
            product_name = zhongan_product_name_from_title(title)
            tasks.append(
                {
                    "company": "众安保险",
                    "productName": product_name,
                    "productType": zhongan_product_type(title, page_info["productType"]),
                    "salesStatus": "公开披露",
                    "category": page_info["label"],
                    "label": "条款",
                    "materialType": "terms",
                    "title": title,
                    "url": material_url,
                    "sourcePage": page_url,
                }
            )
    selected_tasks = tasks[product_offset:]
    if max_products:
        selected_tasks = selected_tasks[:max_products]
    return selected_tasks, page_results


def crawl_zhongan_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=trim(task.get("sourcePage")) or ZHONGAN_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    return {
        "company": trim(task.get("company")) or "众安保险",
        "productName": trim(task.get("productName")),
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")) or "公开披露",
        "title": trim(task.get("title")),
        "url": material_url,
        "snippet": "众安保险官网产品条款，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": "terms",
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or ZHONGAN_STATIC_DOMAIN,
        "parser": "scrapling_zhongan_product_disclosure",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "sourcePage": trim(task.get("sourcePage")),
        "category": trim(task.get("category")),
    }


def crawl_zhongan_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_zhongan_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_zhongan_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_zhongan_pages(payload: dict[str, Any]) -> dict[str, Any]:
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    tasks, pages = zhongan_material_tasks(payload)
    records = crawl_zhongan_material_records(tasks, max_workers=max_workers)
    return {
        "ok": True,
        "company": "众安保险",
        "source": ZHONGAN_PRODUCT_INFO_URL,
        "officialDomain": ZHONGAN_OFFICIAL_DOMAIN,
        "pdfDomain": ZHONGAN_STATIC_DOMAIN,
        "productOffset": max(0, int(payload.get("productOffset") or 0)),
        "maxProducts": max(0, int(payload.get("maxProducts") or 0)),
        "maxWorkers": max_workers,
        "pages": pages,
        "products": [
            {
                "company": task["company"],
                "productName": task["productName"],
                "productType": task["productType"],
                "salesStatus": task["salesStatus"],
                "category": task["category"],
                "sourcePage": task["sourcePage"],
            }
            for task in tasks
        ],
        "materialTaskCount": len(tasks),
        "records": records,
    }


def hongkang_life_status_filter(value: str) -> list[str]:
    text = trim(value)
    if text in {"", "all", "全部"}:
        return ["1", "0"]
    result: list[str] = []
    for token in re.split(r"[,，\s]+", text):
        lower = token.lower()
        if token in HONGKANG_LIFE_SALE_STATUSES:
            result.append(token)
        elif "在售" in token or lower in {"on", "onsale", "in_sale", "available"}:
            result.append("1")
        elif "停售" in token or lower in {"off", "stopped", "sale_end", "discontinued"}:
            result.append("0")
    return list(dict.fromkeys(result)) or ["1", "0"]


def hongkang_life_product_type(product_name: str) -> str:
    if "医疗" in product_name:
        return "医疗险"
    if "疾病" in product_name or "重疾" in product_name or "防癌" in product_name:
        return "健康险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "寿险" in product_name:
        return "寿险"
    return ""


def hongkang_life_pdf_url(value: str) -> str:
    url = trim(value).replace("http://www.hongkang-life.com/", HONGKANG_LIFE_OFFICIAL_BASE_URL)
    return url if url.startswith(HONGKANG_LIFE_OFFICIAL_BASE_URL) else ""


def hongkang_life_responsibility_excerpt(text: str) -> str:
    normalized = normalize_responsibility_source_text(text)
    if not normalized:
        return ""
    heading_re = re.compile(
        r"(?:\d+\s*[.．]\s*)?(?:我们提供的保障\s*)?"
        r"(?:\d+\s*[.．]\s*\d+\s*)?保险责任"
        r"|保险责任\s*在本(?:合同|附加合同)(?:的)?(?:保险期间内|有效期间内|有效期内)"
    )
    end_re = re.compile(
        r"(?:\d+\s*[.．]\s*\d+\s*)?(?:责任免除|其他免责条款|保险金的申请|保险金申请|受益人)"
        r"|(?:\d+\s*[.．]\s*)?(?:保险金的申请|保险金申请|释义|合同解除和变更|明确说明与如实告知)"
    )
    candidates: list[tuple[int, int]] = []
    for match in heading_re.finditer(normalized):
        start = match.start()
        before = normalized[max(0, start - 300) : start]
        near = normalized[start : start + 1200]
        score = responsibility_match_score(normalized, start)
        if re.search(r"(?:2|3)\s*[.．]\s*\d+\s*保险责任", normalized[max(0, start - 30) : start + 30]):
            score += 4
        if re.search(r"在本(?:合同|附加合同).{0,80}(?:我们|本公司).{0,80}(?:承担|给付|赔付|报销)", near):
            score += 6
        if re.search(r"(?:身故|全残|疾病|医疗|住院|意外|满期|生存|年金|豁免).{0,40}保险金", near):
            score += 4
        if re.search(r"阅读指引|条款目录|目\s*录", before + near[:260]):
            score -= 8
        if has_actual_responsibility_text(near[:1000]):
            candidates.append((score, start))
    for _, start in sorted(candidates, key=lambda item: (item[0], item[1]), reverse=True):
        tail = normalized[start:]
        end_match = end_re.search(tail[160:])
        candidate = tail[: 160 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
        candidate = candidate[:MAX_EXCERPT_CHARS].strip()
        if has_actual_responsibility_text(candidate):
            return candidate
    return focused_responsibility_excerpt(text)


def hongkang_life_quality(page_text: str) -> tuple[str, str]:
    if not trim(page_text):
        return "invalid_empty", "no_responsibility_excerpt"
    if not has_actual_responsibility_text(page_text):
        return "invalid_non_responsibility", "missing_actual_responsibility"
    if re.search(r"^(上述|该保险金|本项责任|前述|同时|此外)", trim(page_text)):
        return "valid_partial", "excerpt_starts_mid_clause"
    return "valid_complete", ""


def hongkang_life_products(statuses: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    products: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    for status_code in statuses:
        status, data = post_json_direct(
            HONGKANG_LIFE_PRODUCT_CLAUSE_ENDPOINT,
            {"status": status_code},
            referer=HONGKANG_LIFE_PRODUCT_INFO_URL,
            origin=HONGKANG_LIFE_OFFICIAL_BASE_URL.rstrip("/"),
        )
        items = data.get("list") if isinstance(data.get("list"), list) else []
        pages.append(
            {
                "url": HONGKANG_LIFE_PRODUCT_CLAUSE_ENDPOINT,
                "status": status,
                "saleStatus": HONGKANG_LIFE_SALE_STATUSES.get(status_code, status_code),
                "productCount": len(items),
            }
        )
        if status < 200 or status >= 300 or data.get("code") != 0:
            continue
        for item in items:
            product_name = trim(item.get("name") or item.get("riskName"))
            if not product_name:
                continue
            products.append(
                {
                    "productName": product_name,
                    "riskCode": trim(item.get("riskCode")),
                    "productType": hongkang_life_product_type(product_name),
                    "salesStatus": HONGKANG_LIFE_SALE_STATUSES.get(status_code, status_code),
                    "haltDate": trim(item.get("haltDate")),
                    "files": item.get("files") if isinstance(item.get("files"), list) else [],
                }
            )
    return products, pages


def hongkang_life_material_tasks(products: list[dict[str, Any]], max_products: int) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    selected_products = products[:max_products] if max_products > 0 else products
    for product in selected_products:
        for material in product.get("files", []):
            if trim(material.get("typeCode")) not in {"", "clause"}:
                continue
            material_url = hongkang_life_pdf_url(material.get("filePath"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": "弘康人寿",
                    "productName": product["productName"],
                    "productType": product["productType"],
                    "salesStatus": product["salesStatus"],
                    "riskCode": product["riskCode"],
                    "haltDate": product["haltDate"],
                    "label": trim(material.get("fileName")) or f"{product['productName']}条款",
                    "url": material_url,
                    "fileId": trim(material.get("fileId")),
                    "sourcePage": HONGKANG_LIFE_PRODUCT_INFO_URL,
                }
            )
    return tasks


def crawl_hongkang_life_material_record(task: dict[str, Any]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=HONGKANG_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = hongkang_life_responsibility_excerpt(extracted.get("text", ""))
    quality_status, quality_issue = hongkang_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": "弘康人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": label if product_name in label else f"{product_name}{label}",
        "url": material_url,
        "sourcePage": HONGKANG_LIFE_PRODUCT_INFO_URL,
        "snippet": f"弘康人寿官网公开披露{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": "terms",
        "official": True,
        "officialDomain": HONGKANG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_hongkang_life_product_clause",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "qualityStatus": quality_status,
        "qualityReason": quality_issue,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
    }


def crawl_hongkang_life_material_records(tasks: list[dict[str, Any]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_hongkang_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_hongkang_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_hongkang_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    statuses = hongkang_life_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    products, pages = hongkang_life_products(statuses)
    tasks = hongkang_life_material_tasks(products, max_products=max_products)
    records = crawl_hongkang_life_material_records(tasks, max_workers=max_workers)
    quality_split: dict[str, int] = {}
    for record in records:
        quality = trim(record.get("responsibilityQualityStatus")) or "unknown"
        quality_split[quality] = quality_split.get(quality, 0) + 1
    return {
        "ok": True,
        "company": "弘康人寿",
        "source": HONGKANG_LIFE_PRODUCT_INFO_URL,
        "officialDomain": HONGKANG_LIFE_OFFICIAL_DOMAIN,
        "saleStatuses": [HONGKANG_LIFE_SALE_STATUSES.get(status, status) for status in statuses],
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "productCount": len(products),
        "materialTaskCount": len(tasks),
        "qualitySplit": quality_split,
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


def xiaokang_life_official_url(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
    except Exception:
        return False
    return host in XIAOKANG_LIFE_OFFICIAL_DOMAINS


def xiaokang_life_product_type(product_name: str) -> str:
    return happy_life_product_type(product_name) or "其他"


def xiaokang_life_material_type(label: str) -> str:
    text = trim(label)
    if "说明" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def xiaokang_life_keep_material(label: str, url: str) -> bool:
    text = trim(label)
    if not text or ".pdf" not in trim(url).lower() or not xiaokang_life_official_url(url):
        return False
    if "费率" in text or "现金价值" in text:
        return False
    return "条款" in text or "产品说明" in text


def xiaokang_life_responsibility_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_responsibility", "empty_responsibility_excerpt"
    if re.match(r"^保险责任\s*[，,但]", text):
        return "invalid_responsibility", "definition_or_non_responsibility_clause"
    if "现金价值指" in text[:260] and "保单贷款" in text[:520]:
        return "invalid_responsibility", "cash_value_definition_excerpt"
    return "valid_responsibility", ""


def xiaokang_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"available", "in_sale", "sale", "active", "在售"}:
        return {"在售"}
    if text in {"discontinued", "stopped", "stop", "停售"}:
        return {"停售"}
    return {"在售", "停售"}


def xiaokang_life_product_rows(
    company: str,
    html: str,
    max_products: int = 0,
    offset: int = 0,
    sale_status: set[str] | None = None,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    selected_status = sale_status or {"在售", "停售"}
    seen_products: set[str] = set()
    seen_tasks: set[str] = set()
    row_index = 0

    for anchor in soup.select('a[href*="/1/44/detail-"]'):
        name_node = anchor.select_one(".name")
        product_name = clean_text(name_node.get_text(" ", strip=True) if name_node else anchor.get_text(" ", strip=True))
        detail_url = urljoin(XIAOKANG_LIFE_OFFICIAL_BASE_URL, trim(anchor.get("href")))
        sales_status = trim(anchor.get("data-type"))
        if not product_name or not detail_url or sales_status not in selected_status:
            continue
        row_index += 1
        if offset and row_index <= offset:
            continue
        if max_products and len(products) >= max_products:
            break

        product_type = xiaokang_life_product_type(product_name)
        product_key = f"{product_name}|{sales_status}"
        if product_key not in seen_products:
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "sourcePage": detail_url,
                }
            )

        detail_status, detail_html = fetch_html_direct(detail_url, referer=XIAOKANG_LIFE_PRODUCT_INFO_URL)
        if detail_status < 200 or detail_status >= 300 or not detail_html:
            continue
        detail_soup = BeautifulSoup(detail_html, "html.parser")
        for link in detail_soup.select('a[href$=".pdf"], a[href*=".pdf"]'):
            label = clean_text(link.get_text(" ", strip=True)) or clean_text(link.get("title") or "")
            material_url = urljoin(detail_url, trim(link.get("href")))
            material_type_value = xiaokang_life_material_type(label)
            if not material_type_value or not xiaokang_life_keep_material(label, material_url):
                continue
            task_key = f"{product_name}|{material_url}|{material_type_value}"
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
                    "materialType": material_type_value,
                    "url": material_url,
                    "sourcePage": detail_url,
                }
            )
    return products, tasks


def crawl_xiaokang_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not xiaokang_life_official_url(material_url):
        return None
    status, content_type, data = fetch_binary_direct(material_url, referer=trim(task.get("sourcePage")) or XIAOKANG_LIFE_PRODUCT_INFO_URL)
    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    quality_status, quality_reason = xiaokang_life_responsibility_quality(page_text)
    if quality_status == "invalid_responsibility":
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "小康人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or xiaokang_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"小康人寿官网{label or '产品资料'}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or xiaokang_life_material_type(label),
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or "www.livit-life.com",
        "parser": "scrapling_xiaokang_life_product_info",
        "qualityStatus": quality_status,
        "qualityReason": quality_reason,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
    }


def crawl_xiaokang_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_xiaokang_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_xiaokang_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_xiaokang_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "小康人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    sale_status = xiaokang_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    skip_urls = {trim(item) for item in payload.get("skipUrls", []) if trim(item)}
    status, html = fetch_html_direct(XIAOKANG_LIFE_PRODUCT_INFO_URL, referer=XIAOKANG_LIFE_OFFICIAL_BASE_URL)
    products, tasks = xiaokang_life_product_rows(company, html, max_products=max_products, offset=offset, sale_status=sale_status)
    if skip_urls:
        tasks = [task for task in tasks if trim(task.get("url")) not in skip_urls]
    records = crawl_xiaokang_life_material_records(tasks, max_workers=max_workers)
    status_split: dict[str, int] = {}
    for record in records:
        sales_status = trim(record.get("salesStatus")) or "unknown"
        status_split[sales_status] = status_split.get(sales_status, 0) + 1
    return {
        "ok": True,
        "company": company,
        "source": XIAOKANG_LIFE_PRODUCT_INFO_URL,
        "officialDomain": ",".join(sorted(XIAOKANG_LIFE_OFFICIAL_DOMAINS)),
        "httpStatus": status,
        "saleStatus": sorted(sale_status),
        "maxProducts": max_products,
        "offset": offset,
        "maxWorkers": max_workers,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
        "statusSplit": status_split,
        "pages": [
            {
                "url": XIAOKANG_LIFE_PRODUCT_INFO_URL,
                "status": status,
                "productCount": len(products),
                "materialTaskCount": len(tasks),
                "recordCount": len(records),
            }
        ],
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


def guobao_life_sale_status_filter(value: str) -> str:
    normalized = trim(value).lower()
    if normalized in {"y", "in_sale", "sale", "active", "在售"}:
        return "在售"
    if normalized in {"n", "stopped", "stop", "discontinued", "停售"}:
        return "停售"
    return "all"


def guobao_life_product_type(category: str, product_name: str) -> str:
    category = trim(category)
    if category == "年金险" or "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "医疗" in product_name:
        return "医疗险"
    if category == "健康险" or "重大疾病" in product_name or "疾病" in product_name or "护理" in product_name:
        return "健康险"
    if category in {"意外险", "意外伤害险"} or "意外" in product_name:
        return "意外险"
    if "两全" in product_name:
        return "两全保险"
    if "万能" in product_name:
        return "万能账户"
    if "终身寿险" in product_name or "定期寿险" in product_name or product_name.endswith("寿险"):
        return "寿险"
    return category


def guobao_life_is_official_url(url: str) -> bool:
    host = urlsplit(trim(url)).hostname or ""
    return host == GUOBAO_LIFE_OFFICIAL_DOMAIN


def guobao_life_materials_from_cell(cell: Any, label: str, material_type: str, page_url: str) -> list[dict[str, str]]:
    materials: list[dict[str, str]] = []
    for anchor in cell.find_all("a", href=True):
        material_url = urljoin(page_url, html_lib.unescape(trim(anchor.get("href"))))
        if ".pdf" not in material_url.lower() or not guobao_life_is_official_url(material_url):
            continue
        materials.append({"label": label, "type": material_type, "url": material_url})
    return materials


def guobao_life_product_rows(company: str, html: str, sale_status_filter: str, max_products: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    for index, row in enumerate(soup.find_all("tr"), start=0):
        cells = row.find_all(["td", "th"])
        if len(cells) < 8:
            continue
        product_name = trim(cells[2].get_text(" ", strip=True)).replace("\xa0", " ")
        if not product_name or product_name == "产品名称":
            continue
        sales_status = trim(cells[7].get_text(" ", strip=True))
        if sale_status_filter != "all" and sales_status != sale_status_filter:
            continue
        category = trim(cells[1].get_text(" ", strip=True)).replace("\xa0", " ")
        stop_date = trim(cells[8].get_text(" ", strip=True)) if len(cells) > 8 else ""
        risk_level = trim(cells[9].get_text(" ", strip=True)) if len(cells) > 9 else ""
        materials: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        for material in (
            *guobao_life_materials_from_cell(cells[3], "产品条款", "terms", GUOBAO_LIFE_PRODUCT_INFO_URL),
            *guobao_life_materials_from_cell(cells[5], "产品说明书", "product_manual", GUOBAO_LIFE_PRODUCT_INFO_URL),
        ):
            material_url = trim(material.get("url"))
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            materials.append(material)
        if not materials:
            continue
        product_key = f"{sales_status}|{product_name}"
        if product_key in seen_products:
            continue
        seen_products.add(product_key)
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": guobao_life_product_type(category, product_name),
                "salesStatus": sales_status,
                "sourcePage": GUOBAO_LIFE_PRODUCT_INFO_URL,
                "sourceIndex": index,
                "sourceCategory": category,
                "stopDate": stop_date,
                "riskLevel": risk_level,
                "materials": materials,
            }
        )
        if max_products and len(products) >= max_products:
            break
    return products


def crawl_guobao_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not guobao_life_is_official_url(material_url):
        return None
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or GUOBAO_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "国宝人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"国宝人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": GUOBAO_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_guobao_life_product_info",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_guobao_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_guobao_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_guobao_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
        if record:
            records.append(record)
    return records


def guobao_life_products_and_tasks(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    company = trim(payload.get("company")) or "国宝人寿"
    sale_status_filter = guobao_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    status, html = fetch_html_direct(GUOBAO_LIFE_PRODUCT_INFO_URL)
    page_meta = {
        "url": GUOBAO_LIFE_PRODUCT_INFO_URL,
        "status": status,
        "saleStatus": sale_status_filter,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300:
        return [], [], page_meta
    products = guobao_life_product_rows(company, html, sale_status_filter, max_products)
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for product in products:
        for material in product.get("materials", []):
            material_url = trim(material.get("url"))
            if not material_url or material_url in seen_urls or material_url in skip_urls:
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
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return products, tasks, page_meta


def crawl_guobao_life_material_tasks(payload: dict[str, Any]) -> dict[str, Any]:
    products, tasks, page_meta = guobao_life_products_and_tasks(payload)
    return {
        "ok": page_meta.get("status", 0) >= 200 and page_meta.get("status", 0) < 300,
        "company": trim(payload.get("company")) or "国宝人寿",
        "source": GUOBAO_LIFE_PRODUCT_INFO_URL,
        "officialDomain": GUOBAO_LIFE_OFFICIAL_DOMAIN,
        "pages": [page_meta],
        "products": [{key: value for key, value in product.items() if key != "materials"} for product in products],
        "tasks": tasks,
    }


def crawl_guobao_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "国宝人寿"
    sale_status_filter = guobao_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    products, tasks, page_meta = guobao_life_products_and_tasks(payload)
    if page_meta.get("status", 0) < 200 or page_meta.get("status", 0) >= 300:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}
    records = crawl_guobao_life_material_records(tasks, max_workers=max_workers)
    page_meta["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": GUOBAO_LIFE_PRODUCT_INFO_URL,
        "officialDomain": GUOBAO_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sale_status_filter,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [page_meta],
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


def haibao_life_page_url(base_url: str, page_index: int) -> str:
    return urljoin(base_url, "index.shtml" if page_index <= 1 else f"index_{page_index}.shtml")


def haibao_life_material_type(label: str) -> str:
    return "product_manual" if "说明书" in label else "terms"


def haibao_life_keep_status(profile: dict[str, Any], status_filter: set[str]) -> bool:
    return "all" in status_filter or profile["key"] in status_filter or profile["salesStatus"] in status_filter


def fetch_haibao_life_html(url: str) -> tuple[int, str]:
    status, content_type, data = fetch_binary_direct(url, referer=HAIBAO_LIFE_OFFICIAL_BASE_URL, max_bytes=2_000_000)
    html = data.decode("utf-8", "ignore")
    if status == 200 and ("X-WAF-UUID" in html or "403 Forbidden" in html or "<title>403" in html):
        return 403, html
    return status, html


def fetch_haibao_life_pdf(url: str, referer: str) -> tuple[int, str, bytes]:
    status, content_type, data = fetch_binary_direct(url, referer=referer or HAIBAO_LIFE_OFFICIAL_BASE_URL)
    if status == 200 and not data.startswith(b"%PDF") and (b"403 Forbidden" in data[:1000] or b"X-WAF-UUID" in data[:3000]):
        return 403, content_type, data
    return status, content_type, data


def parse_haibao_life_product_page(company: str, profile: dict[str, Any], page_index: int) -> dict[str, Any]:
    page_url = haibao_life_page_url(profile["baseUrl"], page_index)
    status, html = fetch_haibao_life_html(page_url)
    page_meta = {
        "sourcePage": page_url,
        "status": status,
        "salesStatus": profile["salesStatus"],
        "pageIndex": page_index,
        "productCount": 0,
        "materialTaskCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return {"page": page_meta, "products": [], "tasks": []}

    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for row in soup.select("tr"):
        cells = row.find_all("td")
        if len(cells) < 4:
            continue
        values = [clean_text(cell.get_text(" ", strip=True)) for cell in cells]
        if len(cells) >= 6:
            product_type = values[1]
            product_name = values[2]
            material_cells = [("条款", cells[3]), ("说明书", cells[4])]
        else:
            product_name = values[1]
            product_type = taikang_life_product_type(product_name) or "其他"
            material_cells = [("条款", cells[2]), ("说明书", cells[3])]
        if not product_name or "海保人寿" not in product_name:
            continue

        product_tasks: list[dict[str, str]] = []
        for label, cell in material_cells:
            link = cell.find("a")
            href = trim(link.get("href")) if link else ""
            if not href:
                id_match = re.search(r"\b(\d{5,})\b", cell.get_text(" ", strip=True))
                href = f"/hb/Services/AttachDownLoad.jsp?id={id_match.group(1)}" if id_match else ""
            material_url = urljoin(page_url, href)
            if not href or "AttachDownLoad.jsp" not in material_url:
                continue
            product_tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": profile["salesStatus"],
                    "label": label,
                    "materialType": haibao_life_material_type(label),
                    "url": material_url,
                    "sourcePage": page_url,
                }
            )
        if not product_tasks:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": profile["salesStatus"],
                "sourcePage": page_url,
            }
        )
        tasks.extend(product_tasks)

    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_haibao_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url:
        return None
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
    status, content_type, data = fetch_haibao_life_pdf(
        material_url,
        referer=trim(task.get("sourcePage")) or HAIBAO_LIFE_OFFICIAL_BASE_URL,
    )
    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "海保人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or taikang_life_product_type(product_name) or "其他",
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"海保人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or haibao_life_material_type(label),
        "official": True,
        "officialDomain": HAIBAO_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_haibao_life_product_info",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        **archive_pdf_bytes(data, pdf_archive_dir, material_url),
    }


def crawl_haibao_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_haibao_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_haibao_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_haibao_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "海保人寿"
    status_value = trim(payload.get("saleStatus") or payload.get("status") or "all")
    status_filter = {item.strip() for item in re.split(r"[,，\s]+", status_value) if item.strip()} or {"all"}
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for profile in HAIBAO_LIFE_PRODUCT_PAGES:
        if not haibao_life_keep_status(profile, status_filter):
            continue
        for page_index in range(1, int(profile["pageCount"]) + 1):
            page_result = parse_haibao_life_product_page(company, profile, page_index)
            pages.append(page_result["page"])
            for product in page_result["products"]:
                if max_products and len(products) >= max_products:
                    break
                products.append(product)
                product_name = trim(product.get("productName"))
                for task in page_result["tasks"]:
                    material_url = trim(task.get("url"))
                    if trim(task.get("productName")) != product_name or not material_url or material_url in seen_urls:
                        continue
                    seen_urls.add(material_url)
                    task["pdfArchiveDir"] = pdf_archive_dir
                    tasks.append(task)
            if max_products and len(products) >= max_products:
                break
        if max_products and len(products) >= max_products:
            break

    records = crawl_haibao_life_material_records(tasks, max_workers=max_workers)
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
        "source": HAIBAO_LIFE_PRODUCT_PAGES[0]["baseUrl"],
        "officialDomain": HAIBAO_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


def hsbc_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    output: set[str] = set()
    if text in {"sale", "on_sale", "available", "in_sale", "y", "在售"} or "在售" in text:
        output.add("在售")
    if text in {"stop", "stopped", "off_sale", "discontinued", "n", "停售"} or "停售" in text:
        output.add("停售")
    return output or {"在售", "停售"}


def hsbc_life_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "恶性肿瘤" in product_name or "疾病" in product_name:
        return "重疾险"
    if "医疗" in product_name or "护理" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老金" in product_name or "养老" in product_name or "教育金" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "万能" in product_name:
        return "万能账户"
    if "投资连结" in product_name or "投连" in product_name:
        return "投连险"
    if "增额" in product_name and "终身寿险" in product_name:
        return "增额终身寿险"
    if "定期寿险" in product_name:
        return "定期寿险"
    return "其他"


def hsbc_life_material_type(label: str, header: str, url: str) -> str:
    text = f"{label} {header} {url}"
    if "说明" in text:
        return "product_manual"
    if "条款" in text or "tnc" in url.lower() or "terms" in url.lower():
        return "terms"
    return ""


def hsbc_life_material_label(label: str, material_kind: str) -> str:
    text = trim(label)
    if material_kind == "product_manual":
        return "产品说明书" if "说明" not in text else text
    if material_kind == "terms":
        return "产品条款" if "条款" not in text else text
    return text


def hsbc_life_product_rows(company: str, panel: Any, sales_status: str, max_products: int) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    if not panel:
        return products
    for table in panel.select("table.desktop"):
        rows = table.find_all("tr")
        if not rows:
            continue
        headers = [trim(cell.get_text(" ", strip=True)) for cell in rows[0].find_all(["th", "td"], recursive=False)]
        for row in rows[1:]:
            cells = row.find_all(["td", "th"], recursive=False)
            if not cells:
                continue
            product_name = trim(cells[0].get_text(" ", strip=True))
            if not product_name or product_name in {"产品全称", "产品名称"}:
                continue
            product_key = f"{sales_status}|{product_name}"
            if product_key in seen_products:
                continue
            materials: list[dict[str, str]] = []
            for index, cell in enumerate(cells[1:], start=1):
                header = headers[index] if index < len(headers) else ""
                for anchor in cell.find_all("a"):
                    label = trim(anchor.get_text(" ", strip=True))
                    href = trim(anchor.get("href"))
                    if not href:
                        continue
                    material_url = urljoin(HSBC_LIFE_OFFICIAL_BASE_URL, href)
                    hostname = urlsplit(material_url).netloc.lower()
                    material_kind = hsbc_life_material_type(label, header, material_url)
                    if hostname != HSBC_LIFE_OFFICIAL_DOMAIN or material_kind not in {"terms", "product_manual"}:
                        continue
                    if EXCLUDED_MATERIAL_RE.search(f"{label} {header} {material_url}"):
                        continue
                    materials.append(
                        {
                            "label": hsbc_life_material_label(label, material_kind),
                            "type": material_kind,
                            "url": material_url,
                        }
                    )
            if not materials:
                continue
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": hsbc_life_product_type(product_name),
                    "salesStatus": sales_status,
                    "sourcePage": HSBC_LIFE_PRODUCT_INFO_URL,
                    "materials": materials,
                }
            )
            if max_products and len(products) >= max_products:
                return products
    return products


def crawl_hsbc_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or HSBC_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "汇丰人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"汇丰人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or hsbc_life_material_type(label, label, material_url),
        "official": True,
        "officialDomain": HSBC_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_hsbc_life_product_info",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_hsbc_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_hsbc_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_hsbc_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_hsbc_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "汇丰人寿"
    status_filter = hsbc_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, html = fetch_html_direct(HSBC_LIFE_PRODUCT_INFO_URL)
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_task_urls: set[str] = set()
    if status < 200 or status >= 300:
        return {
            "ok": True,
            "company": company,
            "source": HSBC_LIFE_PRODUCT_INFO_URL,
            "saleStatus": sorted(status_filter),
            "maxProducts": max_products,
            "maxWorkers": max_workers,
            "pages": [{"url": HSBC_LIFE_PRODUCT_INFO_URL, "status": status, "recordCount": 0}],
            "products": [],
            "materialTaskCount": 0,
            "records": [],
        }
    soup = BeautifulSoup(html, "html.parser")
    panel_by_status = {"在售": soup.find(id="03"), "停售": soup.find(id="04")}
    for sales_status in ("在售", "停售"):
        if sales_status not in status_filter:
            continue
        remaining = max_products - len(products) if max_products else 0
        page_products = hsbc_life_product_rows(company, panel_by_status.get(sales_status), sales_status, remaining)
        page_meta = {
            "url": HSBC_LIFE_PRODUCT_INFO_URL,
            "status": status,
            "salesStatus": sales_status,
            "productCount": len(page_products),
            "materialTaskCount": 0,
            "recordCount": 0,
        }
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
        page_meta["materialTaskCount"] = len([task for task in tasks if task.get("salesStatus") == sales_status])
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    records = crawl_hsbc_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_status: dict[str, int] = {}
    task_status_by_url = {trim(task.get("url")): trim(task.get("salesStatus")) for task in tasks}
    for record in records:
        sales_status = task_status_by_url.get(trim(record.get("url")))
        if sales_status:
            record_counts_by_status[sales_status] = record_counts_by_status.get(sales_status, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_status.get(page["salesStatus"], 0)

    return {
        "ok": True,
        "company": company,
        "source": HSBC_LIFE_PRODUCT_INFO_URL,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def huagui_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    output: set[str] = set()
    if text in {"sale", "on_sale", "available", "in_sale", "y", "在售", "在销"} or "在售" in text or "在销" in text:
        output.add("在售")
    if text in {"stop", "stopped", "off_sale", "discontinued", "n", "停售"} or "停售" in text:
        output.add("停售")
    return output or {"在售", "停售"}


def huahui_life_product_type(product_name: str) -> str:
    return taikang_life_product_type(product_name) or "其他"


def huahui_life_sales_status(product_name: str, fallback: str = "") -> str:
    if "停售" in product_name or "停办" in product_name:
        return "停售"
    return trim(fallback) or "在售"


def huahui_life_normalize_product_name(value: str) -> str:
    text = clean_text(value)
    text = text.replace("（", "(").replace("）", ")")
    text = re.sub(r"[（(]\s*已停售\s*[）)]", "", text)
    text = re.sub(r"[（(]\s*停办\s*[）)]", "", text)
    return clean_text(text)


def huahui_life_material_type(label: str) -> str:
    text = trim(label)
    if "说明书" in text or "产品说明" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def huahui_life_official_url(href: str, source_page: str) -> str:
    url = urljoin(source_page or HUAHUI_LIFE_OFFICIAL_BASE_URL, trim(href))
    parts = urlsplit(url)
    if parts.scheme == "http":
        url = urlunsplit(("https", parts.netloc, parts.path, parts.query, parts.fragment))
    return url


def huahui_life_is_official_url(url: str) -> bool:
    hostname = urlsplit(url).netloc.lower()
    return hostname in HUAHUI_LIFE_OFFICIAL_DOMAINS


def huahui_life_terms_page_tasks(company: str, html: str, max_products: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = row.find_all("td", recursive=False)
        if len(cells) < 3:
            continue
        product_label = clean_text(cells[0].get_text(" ", strip=True))
        product_name = huahui_life_normalize_product_name(product_label)
        if not product_name or "华汇人寿" not in product_name:
            continue
        sales_status = huahui_life_sales_status(product_label)
        product_type = huahui_life_product_type(product_name)
        product_tasks: list[dict[str, str]] = []
        for anchor in row.find_all("a"):
            label = clean_text(anchor.get_text(" ", strip=True))
            material_type_value = huahui_life_material_type(label)
            if material_type_value != "terms":
                continue
            material_url = huahui_life_official_url(trim(anchor.get("href")), HUAHUI_LIFE_PRODUCT_TERMS_URL)
            if not huahui_life_is_official_url(material_url) or ".pdf" not in material_url.lower():
                continue
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            product_tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "label": label,
                    "materialType": material_type_value,
                    "url": material_url,
                    "sourcePage": HUAHUI_LIFE_PRODUCT_TERMS_URL,
                }
            )
        if not product_tasks:
            continue
        products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "sourcePage": HUAHUI_LIFE_PRODUCT_TERMS_URL,
            }
        )
        tasks.extend(product_tasks)
        if max_products and len(products) >= max_products:
            break
    return products, tasks


def huahui_life_manual_page_tasks(company: str, html: str, max_products: int, existing_products: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for anchor in soup.find_all("a"):
        label = clean_text(anchor.get_text(" ", strip=True))
        href = trim(anchor.get("href"))
        if not label or "华汇人寿" not in label or not href:
            continue
        material_type_value = huahui_life_material_type("产品说明书")
        product_name = huahui_life_normalize_product_name(label)
        if not product_name:
            continue
        material_url = huahui_life_official_url(href, HUAHUI_LIFE_PRODUCT_MANUAL_URL)
        if not huahui_life_is_official_url(material_url) or ".pdf" not in material_url.lower():
            continue
        if material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        sales_status = huahui_life_sales_status(label, "停售")
        product_type = huahui_life_product_type(product_name)
        if product_name not in existing_products:
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "sourcePage": HUAHUI_LIFE_PRODUCT_MANUAL_URL,
                }
            )
            existing_products.add(product_name)
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "label": "产品说明书",
                "materialType": material_type_value,
                "url": material_url,
                "sourcePage": HUAHUI_LIFE_PRODUCT_MANUAL_URL,
            }
        )
        if max_products and len(existing_products) >= max_products:
            break
    return products, tasks


def huahui_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "blank_or_unextractable"
    if not has_actual_responsibility_text(text):
        return "invalid_non_responsibility", "no_actual_responsibility_text"
    if re.match(r"^(?:上述|该保险金|本项责任|前述|同时|此外|保险责任继续有效)", text):
        return "valid_partial", "starts_mid_clause"
    return "valid_complete", ""


def huahui_life_responsibility_excerpt(text: str) -> str:
    page_text = focused_responsibility_excerpt(text)
    if len(clean_text(page_text)) >= 120:
        return page_text
    normalized = normalize_responsibility_source_text(text)
    matches = list(
        re.finditer(
            r"(?:保险责任\s*)?(?:在本合同有效期内|在本合同保险期间内|在本合同有效期间内).{0,260}?承担保险责任",
            normalized,
        )
    )
    for match in matches:
        start = max(0, match.start() - 80)
        heading = normalized.rfind("保险责任", start, match.start())
        if heading >= 0:
            start = heading
        tail = normalized[start:]
        end_match = re.search(r"(?:责任免除|因下列情形之一.{0,80}不承担|保险金的申请|受益人|其他需要关注的事项|释义)", tail[120:])
        candidate = tail[: 120 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
        candidate = candidate[:MAX_EXCERPT_CHARS].strip()
        if len(clean_text(candidate)) >= 120 and has_actual_responsibility_text(candidate):
            return candidate
    return page_text


def crawl_huahui_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not huahui_life_is_official_url(material_url):
        return None
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
    pdf_status, content_type, data = fetch_binary_direct(
        material_url,
        referer=trim(task.get("sourcePage")) or HUAHUI_LIFE_PRODUCT_TERMS_URL,
    )
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    extracted_text = extracted.get("text", "")
    extraction_method = "pypdf"
    if len(clean_text(extracted_text)) < 200 or "保险责任" not in extracted_text:
        vision_extracted = extract_pdf_text_with_local_vision(data)
        if len(clean_text(vision_extracted.get("text", ""))) > len(clean_text(extracted_text)):
            extracted = vision_extracted
            extracted_text = extracted.get("text", "")
            extraction_method = "macos_vision"
    page_text = huahui_life_responsibility_excerpt(extracted_text)
    quality_status, quality_issue = huahui_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "华汇人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or huahui_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"华汇人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or huahui_life_material_type(label),
        "official": True,
        "officialDomain": HUAHUI_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_huahui_life_product_info",
        "qualityStatus": quality_status,
        "qualityReason": quality_issue,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "pages": extracted.get("pages", 0),
        "extractionMethod": extraction_method,
        "bytes": len(data),
        "contentType": content_type,
        **archive_pdf_bytes(data, pdf_archive_dir, material_url),
    }


def crawl_huahui_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_huahui_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_huahui_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def huahui_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    if text in {"in_sale", "onsale", "on_sale", "sale", "在售"}:
        return {"在售"}
    if text in {"stopped", "stop", "停售"}:
        return {"停售"}
    return {trim(value)}


def crawl_huahui_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "华汇人寿"
    status_filter = huahui_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    skip_urls = set(str(item) for item in payload.get("skipUrls", []) if item)
    pdf_archive_dir = resolve_pdf_archive_dir(payload)

    terms_status, terms_html = fetch_html_direct(HUAHUI_LIFE_PRODUCT_TERMS_URL, referer=HUAHUI_LIFE_OFFICIAL_BASE_URL)
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    if 200 <= terms_status < 300:
        term_products, term_tasks = huahui_life_terms_page_tasks(company, terms_html, max_products)
        products.extend(term_products)
        tasks.extend(term_tasks)
    pages.append(
        {
            "url": HUAHUI_LIFE_PRODUCT_TERMS_URL,
            "status": terms_status,
            "source": "terms",
            "productCount": len(products),
            "materialTaskCount": len(tasks),
        }
    )

    manual_status, manual_html = fetch_html_direct(HUAHUI_LIFE_PRODUCT_MANUAL_URL, referer=HUAHUI_LIFE_OFFICIAL_BASE_URL)
    if 200 <= manual_status < 300 and (not max_products or len(products) < max_products):
        existing_products = {product["productName"] for product in products}
        manual_products, manual_tasks = huahui_life_manual_page_tasks(company, manual_html, max_products, existing_products)
        products.extend(manual_products)
        tasks.extend(manual_tasks)
    pages.append(
        {
            "url": HUAHUI_LIFE_PRODUCT_MANUAL_URL,
            "status": manual_status,
            "source": "product_manual",
            "productCount": len(products),
            "materialTaskCount": len(tasks),
        }
    )

    products = [product for product in products if product["salesStatus"] in status_filter]
    product_names = {product["productName"] for product in products}
    tasks = [
        {**task, "pdfArchiveDir": pdf_archive_dir}
        for task in tasks
        if task["salesStatus"] in status_filter and task["productName"] in product_names and trim(task.get("url")) not in skip_urls
    ]
    records = crawl_huahui_life_material_records(tasks, max_workers=max_workers)
    quality_split: dict[str, int] = {}
    for record in records:
        quality = trim(record.get("responsibilityQualityStatus")) or "unknown"
        quality_split[quality] = quality_split.get(quality, 0) + 1
    for page in pages:
        page["filteredProductCount"] = len(products)
        page["filteredMaterialTaskCount"] = len(tasks)
        page["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": HUAHUI_LIFE_PRODUCT_TERMS_URL,
        "officialDomain": HUAHUI_LIFE_OFFICIAL_DOMAIN,
        "officialDomains": sorted(HUAHUI_LIFE_OFFICIAL_DOMAINS),
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "totalCandidateProductCount": len(products),
        "materialTaskCount": len(tasks),
        "records": records,
        "qualitySplit": quality_split,
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


def huagui_life_sales_status(value: str) -> str:
    text = trim(value)
    if text in {"在销", "在售"}:
        return "在售"
    if "停售" in text:
        return "停售"
    return text


def huagui_life_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "恶性肿瘤" in product_name or "疾病" in product_name:
        return "重疾险"
    if "医疗" in product_name or "护理" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name or "教育金" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "万能" in product_name:
        return "万能账户"
    if "投资连结" in product_name or "投连" in product_name:
        return "投连险"
    if "增额" in product_name and "终身寿险" in product_name:
        return "增额终身寿险"
    if "定期寿险" in product_name:
        return "定期寿险"
    return "其他"


def huagui_life_material_type(label: str) -> str:
    text = trim(label)
    if "说明" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def huagui_life_product_rows(company: str, html: str, max_products: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    if not table:
        return products, tasks
    for row in table.find_all("tr")[1:]:
        cells = row.find_all(["td", "th"], recursive=False)
        if len(cells) < 5:
            continue
        product_name = trim(cells[1].get_text(" ", strip=True))
        sales_status = huagui_life_sales_status(cells[4].get_text(" ", strip=True))
        if not product_name or product_name in seen_products:
            continue
        product = {
            "company": company,
            "productName": product_name,
            "productType": huagui_life_product_type(product_name),
            "salesStatus": sales_status,
            "sourcePage": HUAGUI_LIFE_PRODUCT_INFO_URL,
        }
        product_tasks: list[dict[str, str]] = []
        for cell in cells[2:4]:
            for anchor in cell.find_all("a"):
                label = trim(anchor.get_text(" ", strip=True))
                href = trim(anchor.get("href"))
                material_type = huagui_life_material_type(label)
                if not href or material_type not in {"terms", "product_manual"}:
                    continue
                material_url = urljoin(HUAGUI_LIFE_OFFICIAL_BASE_URL, href)
                hostname = urlsplit(material_url).netloc.lower()
                if hostname != HUAGUI_LIFE_OFFICIAL_DOMAIN or ".pdf" not in material_url.lower():
                    continue
                if material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                product_tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product["productType"],
                        "salesStatus": sales_status,
                        "label": label,
                        "materialType": material_type,
                        "url": material_url,
                        "sourcePage": HUAGUI_LIFE_PRODUCT_INFO_URL,
                    }
                )
        if not product_tasks:
            continue
        seen_products.add(product_name)
        products.append(product)
        tasks.extend(product_tasks)
        if max_products and len(products) >= max_products:
            break
    return products, tasks


def crawl_huagui_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or HUAGUI_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "华贵人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"华贵人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": HUAGUI_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_huagui_life_product_info",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_huagui_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_huagui_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_huagui_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_huagui_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "华贵人寿"
    status_filter = huagui_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status, html = fetch_html_direct(HUAGUI_LIFE_PRODUCT_INFO_URL, referer=HUAGUI_LIFE_OFFICIAL_BASE_URL)
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    if 200 <= status < 300:
        products, tasks = huagui_life_product_rows(company, html, max_products)
        products = [product for product in products if product["salesStatus"] in status_filter]
        product_names = {product["productName"] for product in products}
        tasks = [task for task in tasks if task["salesStatus"] in status_filter and task["productName"] in product_names]
    records = crawl_huagui_life_material_records(tasks, max_workers=max_workers)
    return {
        "ok": True,
        "company": company,
        "source": HUAGUI_LIFE_PRODUCT_INFO_URL,
        "officialDomain": HUAGUI_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": [
            {
                "url": HUAGUI_LIFE_PRODUCT_INFO_URL,
                "status": status,
                "productCount": len(products),
                "materialTaskCount": len(tasks),
                "recordCount": len(records),
            }
        ],
        "products": products,
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
            r"""() => Array.from(document.querySelectorAll('table')).flatMap((table, tableIndex) => {
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


def boc_samsung_life_sm4_crypt(value: bytes, decrypt: bool = False) -> bytes:
    command = [
        "openssl",
        "enc",
        "-d" if decrypt else "-e",
        "-sm4-ecb",
        "-K",
        BOC_SAMSUNG_LIFE_SM4_KEY_HEX,
        "-nosalt",
    ]
    proc = subprocess.run(
        command,
        input=value,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=20,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "ignore")[:300])
    return proc.stdout


def boc_samsung_life_sm4_encrypt_text(value: str) -> str:
    return boc_samsung_life_sm4_crypt(value.encode("utf-8")).hex()


def boc_samsung_life_sm4_decrypt_text(value: str) -> str:
    return boc_samsung_life_sm4_crypt(bytes.fromhex(value), decrypt=True).decode("utf-8", "ignore")


def boc_samsung_life_signed_post(url: str, payload: dict[str, Any], referer: str = "") -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"))
    encrypted_body = boc_samsung_life_sm4_encrypt_text(body)
    timestamp = str(int(time.time() * 1000))
    request_uuid = str(uuid.uuid4())
    replay_sign = boc_samsung_life_sm4_encrypt_text(f"{timestamp}{request_uuid}")
    api_sign = hmac.new(
        BOC_SAMSUNG_LIFE_HMAC_KEY.encode("utf-8"),
        encrypted_body.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    curl_body = json.dumps({"en": encrypted_body}, ensure_ascii=False, separators=(",", ":"))
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-L",
            "-sS",
            "-X",
            "POST",
            "--max-time",
            "45",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            "Content-Type: application/json;charset=UTF-8",
            "-H",
            f"Referer: {referer or BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL}",
            "-H",
            "Origin: https://www.boc-samsunglife.cn",
            "-H",
            f"REQUESTCHECKKEY: REQUEST_CHECK_VALUE_{timestamp}",
            "-H",
            f"X-Timestamp: {timestamp}",
            "-H",
            f"X-Uuid: {request_uuid}",
            "-H",
            f"X-Sign: {replay_sign}",
            "-H",
            f"X-Api-Sign: {api_sign}",
            "--data",
            curl_body,
            url,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
    )
    if proc.returncode != 0:
        return 0, {}
    try:
        response = json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return 200, {}
    encrypted_data = response.get("data")
    if isinstance(encrypted_data, str) and re.fullmatch(r"[0-9a-fA-F]+", encrypted_data or ""):
        try:
            response["data"] = json.loads(boc_samsung_life_sm4_decrypt_text(encrypted_data))
        except Exception:
            response["data"] = {}
    return int(response.get("status") or 200), response


def fetch_boc_samsung_life_product_page(page_number: int, page_size: int) -> tuple[int, dict[str, Any]]:
    status, response = boc_samsung_life_signed_post(
        BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT,
        {"pageNum": page_number, "pageSize": page_size, "queryBean": {}},
        referer="https://www.boc-samsunglife.cn/Information",
    )
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    return status, data


def boc_samsung_life_product_type(product_name: str) -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name or "癌" in product_name:
        return "重疾险"
    if "医疗" in product_name or "住院" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name or "交通" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name or "教育金" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "定期寿险" in product_name:
        return "定期寿险"
    if "万能" in product_name:
        return "万能账户"
    if "投连" in product_name or "投资连结" in product_name:
        return "投连险"
    if "终身寿险" in product_name:
        return "增额终身寿险"
    if "护理" in product_name:
        return "护理险"
    return "其他"


def boc_samsung_life_sales_status(item: dict[str, Any]) -> str:
    state = trim(item.get("state"))
    if state in {"1", "在售", "sale", "Y"}:
        return "在售"
    if state in {"0", "3", "停售", "stop", "N"}:
        return "停售"
    return "公开披露"


def boc_samsung_life_material_type(label: str) -> str:
    if BOC_SAMSUNG_LIFE_EXCLUDED_MATERIAL_RE.search(label):
        return ""
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    if "条款" in label:
        return "terms"
    return ""


def boc_samsung_life_material_url(value: str) -> str:
    material_url = urljoin(BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL, trim(value))
    host = (urlsplit(material_url).hostname or "").lower()
    if host != BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN:
        return ""
    if ".pdf" not in material_url.lower():
        return ""
    return material_url


def boc_samsung_life_tasks_from_item(company: str, item: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    product_name = trim(item.get("productName"))
    if not product_name:
        return None, []
    product = {
        "company": company,
        "productName": product_name,
        "productType": boc_samsung_life_product_type(product_name),
        "salesStatus": boc_samsung_life_sales_status(item),
        "sourcePage": "https://www.boc-samsunglife.cn/Information",
        "productCode": trim(item.get("productCode")),
        "sourceId": trim(item.get("id")),
        "publishedAt": trim(item.get("gmtCreated")),
    }
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    primary_label = trim(item.get("newFileName")) or f"{product_name}条款"
    primary_url = boc_samsung_life_material_url(trim(item.get("newFileUrl")))
    primary_type = boc_samsung_life_material_type(primary_label)
    if primary_url and primary_type:
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product["productType"],
                "salesStatus": product["salesStatus"],
                "label": primary_label,
                "materialType": primary_type,
                "url": primary_url,
                "sourcePage": product["sourcePage"],
            }
        )
        seen_urls.add(primary_url)

    for file_item in item.get("productFileList") or []:
        label = trim(file_item.get("displayName")) or trim(file_item.get("fileName"))
        material_type = boc_samsung_life_material_type(label)
        material_url = boc_samsung_life_material_url(trim(file_item.get("url")))
        if not material_type or not material_url or material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product["productType"],
                "salesStatus": product["salesStatus"],
                "label": label,
                "materialType": material_type,
                "url": material_url,
                "sourcePage": product["sourcePage"],
            }
        )
    return product, tasks


def boc_samsung_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "保险责任正文为空"
    if re.match(r"^(?:保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外|其中)", text):
        return "valid_partial", "疑似从条款中段开始"
    if not has_actual_responsibility_text(text):
        return "suspect_needs_source_check", "缺少明确保险责任触发条件或给付规则"
    return "valid_complete", ""


def crawl_boc_samsung_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    quality_status, quality_issue = boc_samsung_life_quality(page_text)
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "中银三星人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": label or f"{product_name}产品资料",
        "url": material_url,
        "snippet": f"中银三星人寿官网{label or '产品资料'}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_boc_samsung_life_product_info",
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_boc_samsung_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_boc_samsung_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_boc_samsung_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_boc_samsung_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中银三星人寿"
    page_size = max(1, int(payload.get("pageSize") or 20))
    start_page = max(1, int(payload.get("startPage") or 1))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_product_keys: set[str] = set()
    seen_task_urls: set[str] = set()
    page_number = start_page
    fetched_pages = 0

    while True:
        status, data = fetch_boc_samsung_life_product_page(page_number, page_size)
        rows = data.get("list") if isinstance(data.get("list"), list) else []
        page_meta = {
            "url": BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT,
            "status": status,
            "pageNumber": page_number,
            "pageSize": page_size,
            "totalCount": int(data.get("total") or 0),
            "totalPages": int(data.get("pages") or 0),
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            break
        for item in rows:
            product, product_tasks = boc_samsung_life_tasks_from_item(company, item)
            if not product:
                continue
            product_key = f"{product.get('productCode')}|{product.get('productName')}|{product.get('publishedAt')}"
            if product_key not in seen_product_keys:
                if max_products and len(seen_product_keys) >= max_products:
                    continue
                seen_product_keys.add(product_key)
                products.append(product)
                page_meta["productCount"] += 1
            if product_key not in seen_product_keys:
                continue
            for task in product_tasks:
                material_url = trim(task.get("url"))
                if not material_url or material_url in skip_urls or material_url in seen_task_urls:
                    continue
                seen_task_urls.add(material_url)
                tasks.append(task)
                page_meta["materialTaskCount"] += 1
        pages.append(page_meta)
        fetched_pages += 1
        if max_products and len(seen_product_keys) >= max_products:
            break
        if max_pages and fetched_pages >= max_pages:
            break
        if not data.get("hasNextPage"):
            break
        page_number += 1

    records = crawl_boc_samsung_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT for task in tasks}
    record_count = len([record for record in records if trim(record.get("url")) in task_page_by_url])
    for page in pages:
        if page["status"] >= 200 and page["status"] < 300:
            page["recordCount"] = record_count
            break

    return {
        "ok": all(int(page.get("status") or 0) >= 200 and int(page.get("status") or 0) < 300 for page in pages),
        "company": company,
        "source": BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL,
        "endpoint": BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT,
        "startPage": start_page,
        "pageSize": page_size,
        "maxPages": max_pages,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
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
                r"""() => Array.from(document.querySelectorAll('table')).flatMap((table, tableIndex) => {
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


def yingda_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "重大疾病" in name or "重疾" in name or "恶性肿瘤" in name:
        return "重疾险"
    if "医疗" in name or "住院" in name or "津贴" in name:
        return "医疗险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name or "教育" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "定期寿险" in name:
        return "定期寿险"
    if "增额" in name and "终身寿险" in name:
        return "增额终身寿险"
    if "万能" in name:
        return "万能账户"
    return "其他"


def yingda_life_material_type(label: str) -> str:
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    return "terms"


def yingda_life_keep_material(label: str, material_url: str) -> bool:
    text = clean_text(f"{label} {material_url}")
    if not material_url or not material_url.lower().endswith(".pdf"):
        return False
    if re.search(r"费率|现金价值|利益演示|停售说明|公告|提示书", text):
        return False
    return "条款" in text or "产品说明书" in text or "说明书" in text


def yingda_life_fetch_html(url: str, referer: str = "") -> tuple[int, str]:
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-k",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {referer or YINGDA_LIFE_OFFICIAL_BASE_URL}",
            "-w",
            "\n__HTTP_STATUS__:%{http_code}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, ""
    output = proc.stdout.decode("utf-8", "ignore")
    marker = "\n__HTTP_STATUS__:"
    if marker not in output:
        return 0, output
    body, status_text = output.rsplit(marker, 1)
    try:
        status = int(status_text.strip() or "0")
    except ValueError:
        status = 0
    return status, body


def yingda_life_fetch_pdf(url: str, referer: str = "") -> tuple[int, bytes]:
    proc = subprocess.run(
        [
            "curl",
            "--http1.1",
            "-k",
            "-L",
            "-sS",
            "--max-time",
            "35",
            "--user-agent",
            "Mozilla/5.0",
            "-H",
            f"Referer: {referer or YINGDA_LIFE_OFFICIAL_BASE_URL}",
            "-w",
            "\n__HTTP_STATUS__:%{http_code}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=45,
    )
    if proc.returncode != 0:
        return 0, b""
    marker = b"\n__HTTP_STATUS__:"
    output = proc.stdout
    if marker not in output:
        return 0, output[: MAX_PDF_BYTES + 1]
    body, status_bytes = output.rsplit(marker, 1)
    try:
        status = int(status_bytes.strip() or b"0")
    except ValueError:
        status = 0
    return status, body[: MAX_PDF_BYTES + 1]


def yingda_life_page_urls(base_url: str, html: str) -> list[str]:
    soup = BeautifulSoup(html or "", "html.parser")
    urls: list[str] = []
    seen: set[str] = set()

    def add_url(href: str) -> None:
        page_url = urljoin(base_url, trim(href))
        if page_url and page_url not in seen:
            seen.add(page_url)
            urls.append(page_url)

    add_url(base_url)
    for anchor in soup.select(".page a"):
        href = trim(anchor.get("href"))
        if href and "index" in href and href.endswith(".shtml"):
            add_url(href)
    return urls


def yingda_life_parse_list_page(
    page: dict[str, str], page_url: str, html: str, max_products: int
) -> list[dict[str, str]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, str]] = []
    for item in soup.select(".publce_list li"):
        anchor = item.find("a", href=True)
        if not anchor:
            continue
        product_name = html_text(str(anchor))
        detail_url = urljoin(page_url, trim(anchor.get("href")))
        if not product_name or "/gkxxpl/jbxx/cpjbxx/jbtk/" not in detail_url or not detail_url.endswith(".shtml"):
            continue
        products.append(
            {
                "company": "英大人寿",
                "productName": product_name,
                "productType": yingda_life_product_type(product_name),
                "salesStatus": page["salesStatus"],
                "sourcePage": page_url,
                "detailUrl": detail_url,
                "sourceGroup": page["sourceGroup"],
                "pageLabel": page["pageLabel"],
                "publicationDate": trim(item.find("span").get_text(" ", strip=True)) if item.find("span") else "",
            }
        )
        if max_products and len(products) >= max_products:
            break
    return products


def yingda_life_material_tasks(product: dict[str, str], html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html or "", "html.parser")
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for anchor in soup.select(".content_conp a[href]"):
        label = html_text(str(anchor))
        material_url = urljoin(product["detailUrl"], trim(anchor.get("href")))
        host = (urlsplit(material_url).hostname or "").lower()
        if host != YINGDA_LIFE_OFFICIAL_DOMAIN or material_url in seen_urls:
            continue
        if not yingda_life_keep_material(label, material_url):
            continue
        seen_urls.add(material_url)
        tasks.append(
            {
                "company": product["company"],
                "productName": product["productName"],
                "productType": product["productType"],
                "salesStatus": product["salesStatus"],
                "label": label,
                "materialType": yingda_life_material_type(label),
                "url": material_url,
                "sourcePage": product["detailUrl"],
                "sourceGroup": product["sourceGroup"],
                "pageLabel": product["pageLabel"],
                "publicationDate": product["publicationDate"],
            }
        )
    return tasks


def crawl_yingda_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or (urlsplit(material_url).hostname or "").lower() != YINGDA_LIFE_OFFICIAL_DOMAIN:
        return None
    pdf_status, data = yingda_life_fetch_pdf(material_url, referer=trim(task.get("sourcePage")))
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "产品条款"
    return {
        "company": trim(task.get("company")) or "英大人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or yingda_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": label,
        "url": material_url,
        "snippet": f"英大人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or yingda_life_material_type(label),
        "official": True,
        "officialDomain": YINGDA_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_yingda_life_product_info",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_yingda_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_yingda_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_yingda_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_yingda_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "英大人寿"
    status_filter = {trim(item) for item in re.split(r"[,，\s]+", trim(payload.get("saleStatus") or payload.get("status") or "all")) if trim(item)}
    source_filter = {trim(item).lower() for item in re.split(r"[,，\s]+", trim(payload.get("source") or "all")) if trim(item)}
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("productOffset") or 0))
    start_page = max(1, int(payload.get("startPage") or 1))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_detail_urls: set[str] = set()
    seen_task_urls: set[str] = set()
    discovered_product_count = 0

    for profile in YINGDA_LIFE_PRODUCT_PAGES:
        if status_filter and "all" not in status_filter and "全部" not in status_filter and profile["salesStatus"] not in status_filter:
            continue
        if source_filter and "all" not in source_filter and profile["sourceGroup"] not in source_filter and profile["pageLabel"] not in source_filter:
            continue
        if max_products and len(products) >= max_products:
            break
        first_status, first_html = yingda_life_fetch_html(profile["url"])
        page_urls = yingda_life_page_urls(profile["url"], first_html) if 200 <= first_status < 300 and first_html else [profile["url"]]
        for page_index, page_url in enumerate(page_urls, start=1):
            if page_index < start_page:
                continue
            if max_pages and page_index >= start_page + max_pages:
                break
            if max_products and len(products) >= max_products:
                break
            status, html = (first_status, first_html) if page_url == profile["url"] else yingda_life_fetch_html(page_url, referer=profile["url"])
            page_meta = {
                "url": page_url,
                "status": status,
                "pageNumber": page_index,
                "sourceGroup": profile["sourceGroup"],
                "pageLabel": profile["pageLabel"],
                "salesStatus": profile["salesStatus"],
                "productCount": 0,
                "materialTaskCount": 0,
                "recordCount": 0,
            }
            if status < 200 or status >= 300 or not html:
                pages.append(page_meta)
                continue
            page_products = yingda_life_parse_list_page(profile, page_url, html, 0)
            page_task_count = 0
            for product in page_products:
                discovered_product_count += 1
                if discovered_product_count <= product_offset:
                    continue
                detail_url = trim(product.get("detailUrl"))
                if not detail_url or detail_url in seen_detail_urls:
                    continue
                seen_detail_urls.add(detail_url)
                detail_status, detail_html = yingda_life_fetch_html(detail_url, referer=page_url)
                products.append({key: value for key, value in product.items() if key != "detailUrl"})
                if detail_status < 200 or detail_status >= 300 or not detail_html:
                    continue
                for task in yingda_life_material_tasks(product, detail_html):
                    material_url = trim(task.get("url"))
                    if not material_url or material_url in seen_task_urls:
                        continue
                    seen_task_urls.add(material_url)
                    tasks.append(task)
                    page_task_count += 1
                if max_products and len(products) >= max_products:
                    break
            page_meta["productCount"] = len(page_products)
            page_meta["materialTaskCount"] = page_task_count
            pages.append(page_meta)

    records = crawl_yingda_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_page: dict[str, int] = {}
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    detail_page_by_product = {trim(product.get("sourcePage")): trim(product.get("sourcePage")) for product in products}
    for record in records:
        detail_url = task_page_by_url.get(trim(record.get("url")))
        list_url = detail_page_by_product.get(detail_url) or detail_url
        if list_url:
            record_counts_by_page[list_url] = record_counts_by_page.get(list_url, 0) + 1
    for page in pages:
        page["recordCount"] = sum(1 for task in tasks if trim(task.get("pageLabel")) == trim(page.get("pageLabel")))

    return {
        "ok": True,
        "company": company,
        "source": "https://www.ydthlife.com/gkxxpl/jbxx/cpjbxx/jbtk/index.shtml",
        "officialDomain": YINGDA_LIFE_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter) if status_filter else ["all"],
        "sourceFilter": sorted(source_filter) if source_filter else ["all"],
        "maxProducts": max_products,
        "productOffset": product_offset,
        "startPage": start_page,
        "maxPages": max_pages,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


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


def beijing_life_official_url(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
    except Exception:
        return False
    return host in BEIJING_LIFE_OFFICIAL_DOMAINS


def beijing_life_product_type(product_name: str) -> str:
    return taikang_life_product_type(product_name) or "其他"


def beijing_life_material_type(label: str) -> str:
    text = trim(label)
    if "条款" in text or "查看" in text:
        return "terms"
    if "产品说明书" in text or "产品说明" in text:
        return "product_manual"
    return ""


def beijing_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "no_responsibility_excerpt"
    if re.match(r"^(保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外)", text):
        return "valid_partial", "starts_mid_clause_or_continuation"
    if not re.search(r"保险金|给付|赔付|赔偿|报销|豁免|年金|生存|满期|身故|全残|医疗|住院|津贴|护理", text):
        return "invalid_non_responsibility", "no_benefit_trigger_or_payment"
    return "valid_complete", ""


def beijing_life_product_rows(
    company: str, html: str, max_products: int = 0, offset: int = 0
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_tasks: set[str] = set()
    row_index = 0
    for row in soup.select("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 6:
            continue
        first_cell = clean_text(cells[0].get_text(" ", strip=True))
        if not re.fullmatch(r"\d+", first_cell):
            continue
        row_index += 1
        if offset and row_index <= offset:
            continue
        if max_products and len(products) >= max_products:
            break
        product_name = clean_text(cells[1].get_text(" ", strip=True))
        if not product_name or product_name == "产品名称":
            continue
        row_text = clean_text(row.get_text(" ", strip=True))
        sales_status = "停售" if "停售" in row_text else "在售" if "在售" in row_text else ""
        product_type = beijing_life_product_type(product_name)
        product_key = f"{product_name}|{sales_status}"
        if product_key not in seen_products:
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                }
            )
        for cell, fallback_label in [(cells[2], "条款"), (cells[5], "产品说明书")]:
            for anchor in cell.find_all("a", href=True):
                material_url = urljoin(BEIJING_LIFE_OFFICIAL_BASE_URL, trim(anchor.get("href")))
                label = clean_text(anchor.get_text(" ", strip=True)) or clean_text(anchor.get("title") or "") or fallback_label
                material_type_value = beijing_life_material_type(label or fallback_label)
                if not material_type_value or not beijing_life_official_url(material_url):
                    continue
                task_key = f"{product_name}|{material_url}|{material_type_value}"
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
                        "materialType": material_type_value,
                        "url": material_url,
                    }
                )
    return products, tasks


def crawl_beijing_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not beijing_life_official_url(material_url):
        return None
    status, content_type, data = fetch_binary_direct(material_url, referer=BEIJING_LIFE_PRODUCT_INFO_URL)
    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    quality_status, quality_issue = beijing_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    title = f"{product_name}{label if label and label not in product_name else '产品条款'}"
    return {
        "company": trim(task.get("company")) or "北京人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or beijing_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": title,
        "url": material_url,
        "snippet": f"北京人寿官网{label or '产品条款'}，已截取保险责任正文。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or beijing_life_material_type(label),
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or "www.beijinglife.com.cn",
        "parser": "scrapling_beijing_life_product_info",
        "qualityStatus": quality_status,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "pdfPages": extracted.get("pages", 0),
        "contentType": content_type,
    }


def crawl_beijing_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_beijing_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_beijing_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_beijing_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "北京人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    offset = max(0, int(payload.get("offset") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    skip_urls = {trim(item) for item in payload.get("skipUrls", []) if trim(item)}
    status, html = fetch_html(BEIJING_LIFE_PRODUCT_INFO_URL)
    products, tasks = beijing_life_product_rows(company, html, max_products=max_products, offset=offset)
    if skip_urls:
        tasks = [task for task in tasks if trim(task.get("url")) not in skip_urls]
    records = crawl_beijing_life_material_records(tasks, max_workers=max_workers)
    quality_split: dict[str, int] = {}
    status_split: dict[str, int] = {}
    for record in records:
        quality = trim(record.get("responsibilityQualityStatus")) or "unknown"
        quality_split[quality] = quality_split.get(quality, 0) + 1
        sales_status = trim(record.get("salesStatus")) or "unknown"
        status_split[sales_status] = status_split.get(sales_status, 0) + 1
    return {
        "ok": True,
        "company": company,
        "source": BEIJING_LIFE_PRODUCT_INFO_URL,
        "officialDomain": ",".join(sorted(BEIJING_LIFE_OFFICIAL_DOMAINS)),
        "httpStatus": status,
        "maxProducts": max_products,
        "offset": offset,
        "maxWorkers": max_workers,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
        "qualitySplit": quality_split,
        "statusSplit": status_split,
        "pages": [
            {
                "url": BEIJING_LIFE_PRODUCT_INFO_URL,
                "status": status,
                "productCount": len(products),
                "materialTaskCount": len(tasks),
                "recordCount": len(records),
            }
        ],
    }


def ruitai_life_official_url(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
    except Exception:
        return False
    return host in RUITAI_LIFE_OFFICIAL_DOMAINS


def ruitai_life_product_type(product_name: str) -> str:
    return taikang_life_product_type(product_name) or "其他"


def ruitai_life_clean_product_name(title: str) -> str:
    value = clean_text(title)
    value = re.sub(r"^[\d\s.\-—_]+", "", value)
    value = re.sub(r"(?:合同)?(?:产品)?条款.*$", "", value)
    value = re.sub(r"[（(](?:适用|已停售|停售|20\d{2}).*$", "", value)
    value = re.sub(r"[-—_]+$", "", value)
    return clean_text(value) or clean_text(title)


def ruitai_life_terms_tasks(company: str, html: str, max_products: int = 0, offset: int = 0) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, str]] = []
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    seen_products: set[str] = set()
    row_index = 0
    for anchor in soup.select("#toc_total a[href]"):
        href = trim(anchor.get("href"))
        if not href.lower().endswith(".pdf"):
            continue
        row_index += 1
        if offset and row_index <= offset:
            continue
        if max_products and len(products) >= max_products:
            break
        title = clean_text(anchor.get_text(" ", strip=True))
        if not title:
            continue
        material_url = urljoin(RUITAI_LIFE_PRODUCT_TERMS_URL, href)
        if not ruitai_life_official_url(material_url) or material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        product_name = ruitai_life_clean_product_name(title)
        sales_status = "停售" if "停售" in title else "官网披露"
        product_type = ruitai_life_product_type(product_name)
        product_key = f"{product_name}|{sales_status}"
        if product_key not in seen_products:
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                }
            )
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": sales_status,
                "title": title,
                "materialType": "terms",
                "url": material_url,
            }
        )
    return products, tasks


def ruitai_life_responsibility_score(normalized: str, start: int) -> int:
    before = normalized[max(0, start - 80) : start]
    near = normalized[start : start + 900]
    early = near[:320]
    score = responsibility_match_score(normalized, start)
    if re.search(r"(?:\d+[.、]|第[一二三四五六七八九十百]+条)\s*$", before):
        score += 3
    if re.match(r"保险责任\s*(?:在本|本(?:合同|附加合同)|我们|分为|包括|[：:])", near):
        score += 5
    if re.search(r"(?:身故|全残|重大疾病|医疗|住院|意外|护理|年金|生存|满期).{0,60}(?:保险金|给付|报销|赔偿)", near):
        score += 4
    if re.search(r"给付.{0,60}保险金|保险金.{0,60}给付", near):
        score += 3
    if re.search(r"自始不承担|宽限期|解除合同|不再承担保险责任|退还至.*账户", early):
        score -= 10
    if re.match(r"保险责任[。；;，,]", near):
        score -= 8
    return score


def ruitai_life_focused_responsibility_excerpt(text: str) -> str:
    normalized = normalize_responsibility_source_text(text)
    if not normalized:
        return ""
    candidates: list[tuple[int, int]] = []
    for match in re.finditer(r"保险责任", normalized):
        score = ruitai_life_responsibility_score(normalized, match.start())
        if score > 0:
            candidates.append((score, match.start()))
    for _, start in sorted(candidates, key=lambda item: (item[0], -item[1]), reverse=True):
        tail = normalized[start:]
        end_match = RESPONSIBILITY_END_RE.search(tail[60:])
        excerpt = tail[: 60 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
        candidate = excerpt[:MAX_EXCERPT_CHARS].strip()
        if has_actual_responsibility_text(candidate):
            return candidate
    return focused_responsibility_excerpt(text)


def crawl_ruitai_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not ruitai_life_official_url(material_url):
        return None
    status, content_type, data = fetch_binary_direct(material_url, referer=RUITAI_LIFE_PRODUCT_TERMS_URL)
    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = ruitai_life_focused_responsibility_excerpt(extracted.get("text", ""))
    quality_status, quality_issue = beijing_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    title = trim(task.get("title")) or f"{product_name}条款"
    return {
        "company": trim(task.get("company")) or "瑞泰人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or ruitai_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": title,
        "url": material_url,
        "snippet": "瑞泰人寿官网产品条款，已截取保险责任正文。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": "terms",
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or "www.oldmutual-chnenergy.com",
        "parser": "scrapling_ruitai_life_product_terms",
        "qualityStatus": quality_status,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "pdfPages": extracted.get("pages", 0),
        "contentType": content_type,
    }


def crawl_ruitai_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_ruitai_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_ruitai_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_ruitai_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "瑞泰人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    offset = max(0, int(payload.get("offset") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    skip_urls = {trim(item) for item in payload.get("skipUrls", []) if trim(item)}
    status, html = fetch_html(RUITAI_LIFE_PRODUCT_TERMS_URL)
    products, tasks = ruitai_life_terms_tasks(company, html, max_products=max_products, offset=offset)
    if skip_urls:
        tasks = [task for task in tasks if trim(task.get("url")) not in skip_urls]
    records = crawl_ruitai_life_material_records(tasks, max_workers=max_workers)
    quality_split: dict[str, int] = {}
    status_split: dict[str, int] = {}
    for record in records:
        quality = trim(record.get("qualityStatus")) or "unknown"
        quality_split[quality] = quality_split.get(quality, 0) + 1
        sales_status = trim(record.get("salesStatus")) or "unknown"
        status_split[sales_status] = status_split.get(sales_status, 0) + 1
    return {
        "ok": True,
        "company": company,
        "source": RUITAI_LIFE_PRODUCT_TERMS_URL,
        "officialDomain": ",".join(sorted(RUITAI_LIFE_OFFICIAL_DOMAINS)),
        "httpStatus": status,
        "maxProducts": max_products,
        "offset": offset,
        "maxWorkers": max_workers,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
        "qualitySplit": quality_split,
        "statusSplit": status_split,
        "pages": [
            {
                "url": RUITAI_LIFE_PRODUCT_TERMS_URL,
                "status": status,
                "productCount": len(products),
                "materialTaskCount": len(tasks),
                "recordCount": len(records),
            }
        ],
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
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
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
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
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
                record_url = f"{archive_url}#entry={quote(rel_path, safe='')}"
                records.append(
                    {
                        "company": trim(task.get("company")) or "同方全球人寿",
                        "productName": product_name,
                        "productType": trim(task.get("productType")),
                        "salesStatus": trim(task.get("salesStatus")),
                        "title": re.sub(r"\.pdf$", "", basename, flags=re.I),
                        "url": record_url,
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
                        **archive_pdf_bytes(pdf_bytes, pdf_archive_dir, record_url),
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
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
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
                    "pdfArchiveDir": pdf_archive_dir,
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
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


def bob_cardif_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    if text in {"in_sale", "sale", "available", "在售", "y", "1"}:
        return {"在售"}
    if text in {"stopped", "stop", "discontinued", "停售", "n", "0"}:
        return {"停售"}
    return {"在售", "停售"}


def bob_cardif_product_type(product_name: str) -> str:
    name = trim(product_name)
    labels: list[str] = []
    if "医疗" in name or "住院" in name:
        labels.append("医疗险")
    if "护理" in name:
        labels.append("护理险")
    if "重大疾病" in name or "重疾" in name or "恶性肿瘤" in name or "疾病" in name:
        labels.append("重疾险")
    if "意外" in name:
        labels.append("意外险")
    if "养老" in name or "年金" in name or "教育" in name:
        labels.append("年金险")
    if "两全" in name:
        labels.append("两全保险")
    if "定期寿险" in name:
        labels.append("定期寿险")
    if "投连" in name or "投资连结" in name:
        labels.append("投连险")
    if "万能" in name:
        labels.append("万能账户")
    if not labels and "终身寿险" in name:
        labels.append("增额终身寿险")
    if not labels and name.endswith("寿险"):
        labels.append("定期寿险")
    return "、".join(dict.fromkeys(labels)) or "其他"


def bob_cardif_keep_pdf_url(url: str) -> bool:
    parts = urlsplit(url)
    hostname = (parts.hostname or "").lower()
    return parts.scheme in {"http", "https"} and hostname in BOB_CARDIF_OFFICIAL_DOMAINS and parts.path.lower().endswith(".pdf")


def bob_cardif_material_tasks_from_page(page: dict[str, str], html: str) -> tuple[list[dict[str, str]], int]:
    soup = BeautifulSoup(html or "", "html.parser")
    tasks: list[dict[str, str]] = []
    product_count = 0
    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 6:
            continue
        product_name = clean_text(cells[0].get_text(" ", strip=True))
        if not product_name or product_name == "产品名称":
            continue
        product_code = clean_text(cells[1].get_text(" ", strip=True))
        product_count += 1
        for column_index, label, material_type in ((2, "保险条款", "terms"), (5, "产品说明书", "product_manual")):
            if column_index >= len(cells):
                continue
            anchor = cells[column_index].find("a", href=True)
            if not anchor:
                continue
            material_url = urljoin(trim(page.get("url")) or BOB_CARDIF_PRODUCT_INFO_URL, trim(anchor.get("href")))
            if not bob_cardif_keep_pdf_url(material_url):
                continue
            title = f"{product_name}{label}"
            tasks.append(
                {
                    "company": "中荷人寿",
                    "productName": product_name,
                    "productCode": product_code,
                    "productType": bob_cardif_product_type(product_name),
                    "salesStatus": trim(page.get("salesStatus")),
                    "title": title,
                    "label": label,
                    "materialType": material_type,
                    "url": material_url,
                    "sourcePage": trim(page.get("url")),
                    "sourceLabel": trim(page.get("label")),
                }
            )
    return tasks, product_count


def crawl_bob_cardif_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=trim(task.get("sourcePage")) or BOB_CARDIF_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    material_type = trim(task.get("materialType")) or "terms"
    label = "产品说明书" if material_type == "product_manual" else "保险条款"
    return {
        "company": trim(task.get("company")) or "中荷人寿",
        "productName": trim(task.get("productName")),
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": trim(task.get("title")),
        "url": material_url,
        "snippet": f"中荷人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": material_type,
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or BOB_CARDIF_OFFICIAL_DOMAIN,
        "parser": "scrapling_bob_cardif_product_info",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "productCode": trim(task.get("productCode")),
        "sourcePage": trim(task.get("sourcePage")),
        "sourceLabel": trim(task.get("sourceLabel")),
    }


def crawl_bob_cardif_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_bob_cardif_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_bob_cardif_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return sorted(records, key=lambda record: trim(record.get("url")))


def crawl_bob_cardif_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中荷人寿"
    status_filter = bob_cardif_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    product_offset = max(0, int(payload.get("productOffset") or payload.get("offset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    tasks: list[dict[str, str]] = []
    products: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    total_candidate_products = 0
    for page in BOB_CARDIF_PRODUCT_PAGES:
        if page["salesStatus"] not in status_filter:
            continue
        status, html = fetch_html_direct(page["url"], referer=BOB_CARDIF_PRODUCT_INFO_URL)
        page_tasks, product_count = bob_cardif_material_tasks_from_page(page, html)
        total_candidate_products += product_count
        pages.append(
            {
                "url": page["url"],
                "status": status,
                "label": page["label"],
                "salesStatus": page["salesStatus"],
                "productCount": product_count,
                "materialTaskCount": len(page_tasks),
                "recordCount": 0,
            }
        )
        tasks.extend(page_tasks)

    seen_keys: set[str] = set()
    unique_tasks: list[dict[str, str]] = []
    for task in tasks:
        task["company"] = company
        key = f"{trim(task.get('productName'))}|{trim(task.get('materialType'))}|{trim(task.get('url'))}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        unique_tasks.append(task)
    selected_tasks = unique_tasks[product_offset:]
    if max_products:
        selected_tasks = selected_tasks[:max_products]
    for task in selected_tasks:
        products.append(
            {
                "company": company,
                "productName": trim(task.get("productName")),
                "productCode": trim(task.get("productCode")),
                "productType": trim(task.get("productType")),
                "salesStatus": trim(task.get("salesStatus")),
                "sourcePage": trim(task.get("sourcePage")),
            }
        )

    records = crawl_bob_cardif_material_records(selected_tasks, max_workers=max_workers)
    record_count_by_source: dict[str, int] = {}
    for record in records:
        source_page = trim(record.get("sourcePage"))
        record_count_by_source[source_page] = record_count_by_source.get(source_page, 0) + 1
    for page in pages:
        page["recordCount"] = record_count_by_source.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": BOB_CARDIF_PRODUCT_INFO_URL,
        "officialDomain": BOB_CARDIF_OFFICIAL_DOMAIN,
        "officialDomains": sorted(BOB_CARDIF_OFFICIAL_DOMAINS),
        "saleStatus": sorted(status_filter),
        "productOffset": product_offset,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "totalCandidateProductCount": total_candidate_products,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(selected_tasks),
        "records": records,
    }


def fosun_prudential_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return set(FOSUN_PRUDENTIAL_STATUS_PROFILES.keys())
    output: set[str] = set()
    if text in {"zs", "in_sale", "sale", "available", "在售", "y", "1"}:
        output.add("ZS")
    if text in {"ts", "stopped", "stop", "discontinued", "停售", "n", "0"}:
        output.add("TS")
    if text in {"wks", "reported", "not_sold", "unsold", "已报备未销售", "未销售"}:
        output.add("WKS")
    return output or set(FOSUN_PRUDENTIAL_STATUS_PROFILES.keys())


def fosun_prudential_product_type(product_name: str, category: str = "") -> str:
    name = trim(product_name)
    if "医疗" in name or "住院" in name:
        return "医疗险"
    if "意外" in name:
        return "意外险"
    if "护理" in name or "重大疾病" in name or "疾病" in name or "恶性肿瘤" in name:
        return "重疾险"
    if "年金" in name or "养老" in name or "教育" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name:
        return "增额终身寿险"
    if "定期寿险" in name:
        return "定期寿险"
    if "万能" in name:
        return "万能账户"
    if "投连" in name or "投资连结" in name:
        return "投连险"
    return trim(category) or "其他"


def fosun_prudential_material_url(value: str) -> str:
    path = trim(value)
    if not path:
        return ""
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return urljoin(FOSUN_PRUDENTIAL_DOWNLOAD_BASE_URL + "/", path.lstrip("/"))


def fosun_prudential_keep_material_url(url: str) -> bool:
    parts = urlsplit(url)
    hostname = parts.netloc.lower()
    return parts.scheme in {"http", "https"} and any(
        hostname == domain or hostname.endswith("." + domain) for domain in FOSUN_PRUDENTIAL_OFFICIAL_DOMAINS
    )


def fosun_prudential_archive_material_from_filename(filename: str) -> dict[str, str] | None:
    basename = re.split(r"[/\\]+", trim(filename))[-1]
    lower = basename.lower()
    if not lower.endswith(".pdf"):
        return None
    excluded = r"费率|保险费率|现金价值|现价|账户价值|利益演示|投保规则|投保须知|告知书|职业分类|材料清单|清单|批复|备案|回执|声明"
    if re.search(excluded, basename, re.I):
        return None
    if "产品说明书" in basename or "产品说明" in basename:
        return {"label": "产品说明书", "materialType": "product_manual", "basename": basename}
    if "保险条款" in basename or "利益条款" in basename or "条款" in basename:
        return {"label": "保险条款", "materialType": "terms", "basename": basename}
    return None


def fosun_prudential_query_products_sync(product_type: str, page_number: int, page_size: int, product_name: str = "") -> dict[str, Any]:
    async def run() -> dict[str, Any]:
        from playwright.async_api import async_playwright

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            page = await browser.new_page(user_agent="Mozilla/5.0")
            try:
                await page.goto(FOSUN_PRUDENTIAL_PRODUCT_INFO_URL, wait_until="networkidle", timeout=60000)
                return await page.evaluate(
                    """async ({productType, pageNum, pageSize, productName}) => {
                      const response = await window.utils.http.postJson('/columnArticle/queryProductDataList', {
                        menuCode: 'productData',
                        productType,
                        pageNum,
                        pageSize,
                        productName
                      });
                      return response.data;
                    }""",
                    {
                        "productType": product_type,
                        "pageNum": page_number,
                        "pageSize": page_size,
                        "productName": product_name,
                    },
                )
            finally:
                await browser.close()

    return asyncio.run(run())


def fosun_prudential_extract_page_data(response: dict[str, Any]) -> dict[str, Any]:
    if response.get("state") == "success":
        response = response.get("data") or {}
    if response.get("code") == "200":
        response = response.get("data") or {}
    if isinstance(response.get("data"), dict):
        response = response.get("data") or {}
    return response if isinstance(response, dict) else {}


def fosun_prudential_product_rows(
    company: str,
    status_key: str,
    response_data: dict[str, Any],
    skipped_products: int,
    max_products: int,
    selected_count: int,
    include_archives: bool,
) -> tuple[list[dict[str, Any]], int, int]:
    profile = FOSUN_PRUDENTIAL_STATUS_PROFILES[status_key]
    products: list[dict[str, Any]] = []
    for item in response_data.get("list") or []:
        product_name = trim(item.get("productName"))
        if not product_name:
            continue
        if skipped_products > 0:
            skipped_products -= 1
            continue
        if max_products and selected_count + len(products) >= max_products:
            break
        product = {
            "company": company,
            "productName": product_name,
            "productType": fosun_prudential_product_type(product_name, trim(item.get("productCategory"))),
            "salesStatus": profile["salesStatus"],
            "sourcePage": FOSUN_PRUDENTIAL_PRODUCT_INFO_URL,
            "sourceList": status_key,
            "sourceLabel": profile["label"],
            "productId": trim(item.get("id")),
            "productCategory": trim(item.get("productCategory")),
            "stopTime": trim(item.get("stopTime")),
            "createTime": trim(item.get("createTime")),
            "hisNum": int(item.get("hisNum") or 0),
            "materials": [],
        }
        terms_url = fosun_prudential_material_url(item.get("productTerms"))
        if terms_url and fosun_prudential_keep_material_url(terms_url):
            product["materials"].append(
                {
                    "label": "产品条款",
                    "materialType": "terms",
                    "url": terms_url,
                    "sourceField": "productTerms",
                }
            )
        other_url = fosun_prudential_material_url(item.get("otherMaterials"))
        if include_archives and other_url and fosun_prudential_keep_material_url(other_url):
            product["materials"].append(
                {
                    "label": "其他产品信息",
                    "materialType": "archive",
                    "url": other_url,
                    "sourceField": "otherMaterials",
                }
            )
        products.append(product)
    return products, skipped_products, selected_count + len(products)


def crawl_fosun_prudential_material_record(task: dict[str, str]) -> list[dict[str, Any]]:
    material_url = trim(task.get("url"))
    if not fosun_prudential_keep_material_url(material_url):
        return []
    material_type = trim(task.get("materialType"))
    if material_type in {"terms", "product_manual"}:
        status, data = fetch_bytes_direct(material_url, referer=FOSUN_PRUDENTIAL_PRODUCT_INFO_URL)
        if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
            return []
        extracted = extract_pdf_text_with_system_python(data)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        if not page_text or "保险责任" not in page_text:
            return []
        product_name = trim(task.get("productName"))
        label = trim(task.get("label")) or "产品条款"
        return [
            {
                "company": trim(task.get("company")) or "复星保德信人寿",
                "productName": product_name,
                "productType": trim(task.get("productType")),
                "salesStatus": trim(task.get("salesStatus")),
                "title": f"{product_name}{label}",
                "url": material_url,
                "snippet": f"复星保德信官网{label}，已截取保险责任正文段。",
                "pageText": page_text,
                "sourceType": "pdf",
                "materialType": material_type,
                "official": True,
                "officialDomain": FOSUN_PRUDENTIAL_OFFICIAL_DOMAIN,
                "parser": "scrapling_fosun_prudential_product_info",
                "qualityStatus": "valid_complete",
                "responsibilityQualityStatus": "valid_complete",
                "responsibilityQualityIssue": "",
                "pages": extracted.get("pages", 0),
                "bytes": len(data),
                "sourcePage": trim(task.get("sourcePage")),
                "sourceList": trim(task.get("sourceList")),
                "productCategory": trim(task.get("productCategory")),
            }
        ]
    if material_type != "archive":
        return []
    status, data = fetch_bytes_direct_limited(
        material_url,
        referer=FOSUN_PRUDENTIAL_PRODUCT_INFO_URL,
        max_bytes=MAX_ZIP_BYTES,
        max_time=90,
    )
    if status < 200 or status >= 300 or len(data) > MAX_ZIP_BYTES:
        return []
    suffix = ".zip" if data.startswith(b"PK") or urlsplit(material_url).path.lower().endswith(".zip") else ".rar" if data.startswith(b"Rar!") or urlsplit(material_url).path.lower().endswith(".rar") else ""
    if suffix not in {".zip", ".rar"}:
        return []
    records: list[dict[str, Any]] = []
    bsdtar = os.environ.get("BSDTAR_BIN") or "/usr/bin/bsdtar"
    with tempfile.TemporaryDirectory(prefix="fosun-prudential-") as temp_dir:
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
                material = fosun_prudential_archive_material_from_filename(rel_path)
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
                records.append(
                    {
                        "company": trim(task.get("company")) or "复星保德信人寿",
                        "productName": product_name,
                        "productType": trim(task.get("productType")),
                        "salesStatus": trim(task.get("salesStatus")),
                        "title": re.sub(r"\.pdf$", "", material["basename"], flags=re.I),
                        "url": f"{material_url}#entry={quote(rel_path, safe='')}",
                        "snippet": f"复星保德信官网产品资料包内{label}，已截取保险责任正文段。",
                        "pageText": page_text,
                        "sourceType": "archive_pdf",
                        "materialType": material["materialType"],
                        "official": True,
                        "officialDomain": FOSUN_PRUDENTIAL_OFFICIAL_DOMAIN,
                        "parser": "scrapling_fosun_prudential_product_info",
                        "qualityStatus": "valid_complete",
                        "responsibilityQualityStatus": "valid_complete",
                        "responsibilityQualityIssue": "",
                        "pages": extracted.get("pages", 0),
                        "bytes": len(pdf_bytes),
                        "archiveUrl": material_url,
                        "sourcePage": trim(task.get("sourcePage")),
                        "sourceList": trim(task.get("sourceList")),
                        "productCategory": trim(task.get("productCategory")),
                    }
                )
    return records


def crawl_fosun_prudential_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records: list[dict[str, Any]] = []
        for task in tasks:
            records.extend(crawl_fosun_prudential_material_record(task))
        return sorted(records, key=lambda record: trim(record.get("url")))
    records = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_fosun_prudential_material_record, task) for task in tasks]
        for future in as_completed(futures):
            records.extend(future.result())
    return sorted(records, key=lambda record: trim(record.get("url")))


def crawl_fosun_prudential_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "复星保德信人寿"
    status_filter = fosun_prudential_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    include_archives = bool(payload.get("includeArchives"))
    page_size = max(1, int(payload.get("pageSize") or payload.get("page_size") or 50))
    offset = max(0, int(payload.get("offset") or payload.get("startOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    product_name_filter = trim(payload.get("productName"))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    skipped_products = offset
    total_candidate_products = 0
    selected_count = 0

    for status_key, profile in FOSUN_PRUDENTIAL_STATUS_PROFILES.items():
        if status_key not in status_filter:
            continue
        page_number = 1
        total_pages = 1
        while page_number <= total_pages:
            response = fosun_prudential_query_products_sync(status_key, page_number, page_size, product_name_filter)
            data = fosun_prudential_extract_page_data(response)
            total_pages = int(data.get("pages") or total_pages or 1)
            page_rows = data.get("list") or []
            total_candidate_products += len([row for row in page_rows if trim(row.get("productName"))])
            page_products, skipped_products, selected_count = fosun_prudential_product_rows(
                company,
                status_key,
                data,
                skipped_products,
                max_products,
                selected_count,
                include_archives,
            )
            products.extend([{key: value for key, value in product.items() if key != "materials"} for product in page_products])
            for product in page_products:
                for material in product["materials"]:
                    tasks.append(
                        {
                            "company": company,
                            "productName": product["productName"],
                            "productType": product["productType"],
                            "salesStatus": product["salesStatus"],
                            "label": material["label"],
                            "materialType": material["materialType"],
                            "url": material["url"],
                            "sourcePage": product["sourcePage"],
                            "sourceList": product["sourceList"],
                            "productCategory": product["productCategory"],
                        }
                    )
            pages.append(
                {
                    "url": FOSUN_PRUDENTIAL_PRODUCT_INFO_URL,
                    "status": 200 if data else 0,
                    "sourceList": status_key,
                    "label": profile["label"],
                    "salesStatus": profile["salesStatus"],
                    "pageNumber": page_number,
                    "totalPages": total_pages,
                    "total": int(data.get("total") or 0),
                    "productCount": len(page_products),
                    "materialTaskCount": sum(len(product["materials"]) for product in page_products),
                    "recordCount": 0,
                }
            )
            if max_products and selected_count >= max_products:
                break
            if not data.get("hasNextPage") and page_number >= total_pages:
                break
            page_number += 1
        if max_products and selected_count >= max_products:
            break

    records = crawl_fosun_prudential_material_records(tasks, max_workers=max_workers)
    counts_by_list: dict[str, int] = {}
    task_list_by_url = {trim(task.get("url")): trim(task.get("sourceList")) for task in tasks}
    for record in records:
        source_url = trim(record.get("archiveUrl")) or trim(record.get("url")).split("#", 1)[0]
        source_list = task_list_by_url.get(source_url)
        if source_list:
            counts_by_list[source_list] = counts_by_list.get(source_list, 0) + 1
    for page_meta in pages:
        page_meta["recordCount"] = counts_by_list.get(trim(page_meta.get("sourceList")), 0)

    return {
        "ok": True,
        "company": company,
        "source": FOSUN_PRUDENTIAL_PRODUCT_INFO_URL,
        "officialDomain": FOSUN_PRUDENTIAL_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "offset": offset,
        "maxProducts": max_products,
        "pageSize": page_size,
        "includeArchives": include_archives,
        "totalCandidateProductCount": total_candidate_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def fosun_uhi_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return set(FOSUN_UHI_STATUS_PROFILES.keys())
    if text in {"in_sale", "sale", "available", "在售", "y", "1"}:
        return {key for key, profile in FOSUN_UHI_STATUS_PROFILES.items() if profile["salesStatus"] == "在售"}
    if text in {"stopped", "stop", "discontinued", "停售", "n", "0"}:
        return {key for key, profile in FOSUN_UHI_STATUS_PROFILES.items() if profile["salesStatus"] == "停售"}
    return set(FOSUN_UHI_STATUS_PROFILES.keys())


def fosun_uhi_segment_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"个人保险", "团体保险"}
    if text in {"personal", "individual", "个人", "个险", "s"}:
        return {"个人保险"}
    if text in {"group", "团体", "团险", "g"}:
        return {"团体保险"}
    return {"个人保险", "团体保险"}


def fosun_uhi_product_type(product_name: str) -> str:
    name = trim(product_name)
    labels = []
    if "重大疾病" in name or "特定疾病" in name or "疾病保险" in name:
        labels.append("重疾险")
    if "医疗" in name or "住院" in name or "高端" in name:
        labels.append("医疗险")
    if "意外" in name:
        labels.append("意外险")
    if "护理" in name:
        labels.append("护理险")
    if "寿险" in name or "定期寿险" in name:
        labels.append("定期寿险")
    if "年金" in name:
        labels.append("年金险")
    return "、".join(dict.fromkeys(labels)) or "其他"


def fosun_uhi_material_url(value: Any) -> str:
    path = trim(value)
    if not path:
        return ""
    return urljoin(FOSUN_UHI_PRODUCT_INFO_URL, path)


def fosun_uhi_is_official_url(url: str) -> bool:
    hostname = urlsplit(trim(url)).hostname or ""
    return any(hostname == domain or hostname.endswith("." + domain) for domain in FOSUN_UHI_OFFICIAL_DOMAINS)


def post_fosun_uhi_product_page(current_page: int, single_or_group: str, is_show: str, product_name: str = "") -> tuple[int, dict[str, Any]]:
    form = {
        "currentPage": str(current_page),
        "singleOrGroup": single_or_group,
        "isShow": is_show,
    }
    if product_name:
        form["productName"] = product_name
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
            "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
            "-H",
            f"Referer: {FOSUN_UHI_PRODUCT_IFRAME_URL}",
            "-w",
            "\n%{http_code}",
            "--data-binary",
            urlencode(form),
            FOSUN_UHI_PRODUCT_ENDPOINT,
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


def fosun_uhi_product_rows(
    company: str,
    profile_key: str,
    response_data: dict[str, Any],
    skipped_products: int,
    max_products: int,
    selected_count: int,
) -> tuple[list[dict[str, Any]], int, int]:
    profile = FOSUN_UHI_STATUS_PROFILES[profile_key]
    products: list[dict[str, Any]] = []
    for item in response_data.get("priductLsit") or []:
        product_name = trim(item.get("productName"))
        if not product_name:
            continue
        if skipped_products > 0:
            skipped_products -= 1
            continue
        if max_products and selected_count + len(products) >= max_products:
            break
        product = {
            "company": company,
            "productName": product_name,
            "productType": fosun_uhi_product_type(product_name),
            "salesStatus": profile["salesStatus"],
            "segment": profile["segment"],
            "sourcePage": FOSUN_UHI_PRODUCT_INFO_URL,
            "sourceList": profile_key,
            "sourceLabel": profile["label"],
            "productId": trim(item.get("id")),
            "productCode": trim(item.get("productCode")),
            "startOfSaleDate": trim(item.get("startOfSaleDate")),
            "endOfSaleDate": trim(item.get("endOfSaleDate")),
            "materials": [],
        }
        terms_url = fosun_uhi_material_url(item.get("url"))
        if terms_url and fosun_uhi_is_official_url(terms_url):
            product["materials"].append({"label": "产品条款", "materialType": "terms", "url": terms_url})
        manual_url = fosun_uhi_material_url(item.get("productIns"))
        if manual_url and fosun_uhi_is_official_url(manual_url):
            product["materials"].append({"label": "产品说明书", "materialType": "product_manual", "url": manual_url})
        products.append(product)
    return products, skipped_products, selected_count + len(products)


def crawl_fosun_uhi_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not fosun_uhi_is_official_url(material_url):
        return None
    status, data = fetch_bytes_direct(material_url, referer=FOSUN_UHI_PRODUCT_IFRAME_URL)
    if status < 200 or status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = fosun_uhi_responsibility_excerpt(extracted.get("text", "")) or focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "产品条款"
    return {
        "company": trim(task.get("company")) or "复星联合健康保险",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"复星联合健康保险官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": FOSUN_UHI_OFFICIAL_DOMAIN,
        "parser": "scrapling_fosun_uhi_product_info",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "sourcePage": trim(task.get("sourcePage")),
        "sourceList": trim(task.get("sourceList")),
        "segment": trim(task.get("segment")),
        "productCode": trim(task.get("productCode")),
        "startOfSaleDate": trim(task.get("startOfSaleDate")),
        "endOfSaleDate": trim(task.get("endOfSaleDate")),
    }


def fosun_uhi_responsibility_excerpt(text: str) -> str:
    normalized = normalize_responsibility_source_text(text)
    if not normalized:
        return ""
    candidates: list[tuple[int, int, str]] = []
    for match in re.finditer(r"(?:\d+(?:[．.]\d+)+|第[一二三四五六七八九十百]+条)\s*保险责任", normalized):
        start = match.start()
        if is_responsibility_toc_context(normalized, start):
            continue
        tail = normalized[start:]
        end_match = re.search(
            r"(?:\s\d+(?:[．.]\d+)+\s*(?:责任免除|未成年人限制|保险金申领|受益人|保险费|现金价值|合同效力|释义)|责任免除)",
            tail[900:],
        )
        raw_candidate = tail[: 900 + end_match.start()] if end_match else tail[: MAX_EXCERPT_CHARS * 2]
        candidate = raw_candidate[:MAX_EXCERPT_CHARS].strip()
        if not has_actual_responsibility_text(candidate):
            continue
        score = responsibility_match_score(normalized, start)
        if re.search(r"(?:\d+(?:[．.]\d+)+|第[一二三四五六七八九十百]+条)\s*保险责任", candidate[:40]):
            score += 6
        if "目 录" in normalized[max(0, start - 200) : start] or "条款目录" in normalized[max(0, start - 200) : start]:
            score -= 8
        candidates.append((score, -start, candidate))
    if not candidates:
        return ""
    return max(candidates, key=lambda item: (item[0], item[1]))[2]


def crawl_fosun_uhi_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        records = [crawl_fosun_uhi_material_record(task) for task in tasks]
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            records = list(executor.map(crawl_fosun_uhi_material_record, tasks))
    return sorted([record for record in records if record], key=lambda record: trim(record.get("url")))


def crawl_fosun_uhi_health_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "复星联合健康保险"
    status_filter = fosun_uhi_sale_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    segment_filter = fosun_uhi_segment_filter(trim(payload.get("segment")))
    offset = max(0, int(payload.get("offset") or payload.get("startOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    product_name_filter = trim(payload.get("productName"))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    skipped_products = offset
    total_candidate_products = 0
    selected_count = 0

    for profile_key, profile in FOSUN_UHI_STATUS_PROFILES.items():
        if profile_key not in status_filter or profile["segment"] not in segment_filter:
            continue
        single_or_group, is_show = profile_key.split(":", 1)
        page_number = 1
        total_pages = 1
        while page_number <= total_pages:
            status, data = post_fosun_uhi_product_page(page_number, single_or_group, is_show, product_name_filter)
            total_pages = max(1, int(data.get("pageSize") or total_pages or 1))
            page_rows = data.get("priductLsit") or []
            total_candidate_products += len([row for row in page_rows if trim(row.get("productName"))])
            page_products, skipped_products, selected_count = fosun_uhi_product_rows(
                company,
                profile_key,
                data,
                skipped_products,
                max_products,
                selected_count,
            )
            products.extend([{key: value for key, value in product.items() if key != "materials"} for product in page_products])
            for product in page_products:
                for material in product["materials"]:
                    tasks.append(
                        {
                            "company": company,
                            "productName": product["productName"],
                            "productType": product["productType"],
                            "salesStatus": product["salesStatus"],
                            "label": material["label"],
                            "materialType": material["materialType"],
                            "url": material["url"],
                            "sourcePage": product["sourcePage"],
                            "sourceList": product["sourceList"],
                            "segment": product["segment"],
                            "productCode": product["productCode"],
                            "startOfSaleDate": product["startOfSaleDate"],
                            "endOfSaleDate": product["endOfSaleDate"],
                        }
                    )
            pages.append(
                {
                    "url": FOSUN_UHI_PRODUCT_ENDPOINT,
                    "status": status,
                    "sourceList": profile_key,
                    "label": profile["label"],
                    "salesStatus": profile["salesStatus"],
                    "segment": profile["segment"],
                    "pageNumber": page_number,
                    "totalPages": total_pages,
                    "productCount": len(page_products),
                    "materialTaskCount": sum(len(product["materials"]) for product in page_products),
                    "recordCount": 0,
                }
            )
            if max_products and selected_count >= max_products:
                break
            page_number += 1
        if max_products and selected_count >= max_products:
            break

    records = crawl_fosun_uhi_material_records(tasks, max_workers=max_workers)
    record_counts_by_list: dict[str, int] = {}
    task_list_by_url = {trim(task.get("url")): trim(task.get("sourceList")) for task in tasks}
    for record in records:
        source_list = task_list_by_url.get(trim(record.get("url")))
        if source_list:
            record_counts_by_list[source_list] = record_counts_by_list.get(source_list, 0) + 1
    for page_meta in pages:
        page_meta["recordCount"] = record_counts_by_list.get(trim(page_meta.get("sourceList")), 0)

    return {
        "ok": True,
        "company": company,
        "source": FOSUN_UHI_PRODUCT_INFO_URL,
        "officialDomain": FOSUN_UHI_OFFICIAL_DOMAIN,
        "saleStatus": sorted(status_filter),
        "segment": sorted(segment_filter),
        "offset": offset,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "totalCandidateProductCount": total_candidate_products,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def citic_prudential_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    output: set[str] = set()
    if text in {"sale", "available", "in_sale", "在售", "y", "1"}:
        output.add("在售")
    if text in {"stopped", "stop", "discontinued", "停售", "n", "0"}:
        output.add("停售")
    return output or {"在售", "停售"}


def citic_prudential_product_type(product_name: str) -> str:
    name = trim(product_name)
    labels: list[str] = []
    if "医疗" in name or "住院" in name:
        labels.append("医疗险")
    if "护理" in name:
        labels.append("护理险")
    if "重大疾病" in name or "重疾" in name or "恶性肿瘤" in name or "疾病" in name:
        labels.append("重疾险")
    if "意外" in name:
        labels.append("意外险")
    if "养老" in name or "年金" in name or "教育" in name:
        labels.append("年金险")
    if "两全" in name:
        labels.append("两全保险")
    if "定期寿险" in name:
        labels.append("定期寿险")
    if "终身寿险" in name:
        labels.append("增额终身寿险" if "增额" in name else "定期寿险")
    if "万能" in name:
        labels.append("万能账户")
    if "投连" in name or "投资连结" in name:
        labels.append("投连险")
    return "、".join(dict.fromkeys(labels)) or "其他"


def citic_prudential_keep_material_url(url: str) -> bool:
    parts = urlsplit(url)
    hostname = (parts.hostname or "").lower()
    return parts.scheme in {"http", "https"} and hostname in CITIC_PRUDENTIAL_OFFICIAL_DOMAINS


def citic_prudential_material_tasks_from_page(company: str, html: str, status_filter: set[str]) -> tuple[list[dict[str, str]], int]:
    soup = BeautifulSoup(html or "", "html.parser")
    tasks: list[dict[str, str]] = []
    product_count = 0
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 3:
            continue
        sales_status = clean_text(cells[0].get_text(" ", strip=True))
        if sales_status not in {"在售", "停售"}:
            continue
        product_name = clean_text(cells[1].get_text(" ", strip=True))
        if not product_name:
            continue
        product_count += 1
        if sales_status not in status_filter:
            continue
        anchor = cells[2].find("a", href=True)
        if not anchor:
            continue
        label = clean_text(anchor.get_text(" ", strip=True)) or "条款PDF文档"
        if "条款" not in label:
            continue
        material_url = urljoin(CITIC_PRUDENTIAL_PRODUCT_INFO_URL, trim(anchor.get("href")))
        if not citic_prudential_keep_material_url(material_url) or material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": citic_prudential_product_type(product_name),
                "salesStatus": sales_status,
                "title": f"{product_name}产品条款",
                "label": "产品条款",
                "materialType": "terms",
                "url": material_url,
                "sourcePage": CITIC_PRUDENTIAL_PRODUCT_INFO_URL,
                "filingNature": clean_text(cells[3].get_text(" ", strip=True)) if len(cells) > 3 else "",
                "filingNumber": clean_text(cells[4].get_text(" ", strip=True)) if len(cells) > 4 else "",
                "clauseCode": clean_text(cells[5].get_text(" ", strip=True)) if len(cells) > 5 else "",
            }
        )
    return tasks, product_count


def citic_prudential_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "blank_or_placeholder"
    if not has_actual_responsibility_text(text):
        return "invalid_non_responsibility", "no_actual_responsibility_text"
    if re.search(r"^(保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外)", text):
        return "valid_partial", "starts_mid_clause"
    return "valid_complete", ""


def citic_prudential_responsibility_excerpt(text: str) -> str:
    page_text = focused_responsibility_excerpt(text)
    if page_text:
        return page_text
    normalized = normalize_responsibility_source_text(text)
    match = re.search(r"(?:\d+\.\d+\s*)?保险责任", normalized)
    if not match:
        return ""
    tail = normalized[match.start() :]
    end_match = re.search(r"(?:\d+\.\d+\s*)?(?:除外责任|责任免除|受益人|保险金的申请|保险金的给付|诉讼时效|名词释义)", tail[180:])
    excerpt = tail[: 180 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
    if has_actual_responsibility_text(excerpt):
        return excerpt[:MAX_EXCERPT_CHARS]
    return ""


def crawl_citic_prudential_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not citic_prudential_keep_material_url(material_url):
        return None
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=CITIC_PRUDENTIAL_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = citic_prudential_responsibility_excerpt(extracted.get("text", ""))
    status, issue = citic_prudential_quality(page_text)
    if status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    return {
        "company": trim(task.get("company")) or "中信保诚人寿",
        "productName": trim(task.get("productName")),
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": trim(task.get("title")),
        "url": material_url,
        "snippet": "中信保诚官网产品条款，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": "terms",
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or CITIC_PRUDENTIAL_OFFICIAL_DOMAIN,
        "parser": "scrapling_citic_prudential_product_info",
        "qualityStatus": status,
        "qualityReason": issue,
        "responsibilityQualityStatus": status,
        "responsibilityQualityIssue": issue,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "sourcePage": trim(task.get("sourcePage")),
        "filingNature": trim(task.get("filingNature")),
        "filingNumber": trim(task.get("filingNumber")),
        "clauseCode": trim(task.get("clauseCode")),
    }


def crawl_citic_prudential_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_citic_prudential_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_citic_prudential_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return sorted(records, key=lambda record: trim(record.get("url")))


def crawl_citic_prudential_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中信保诚人寿"
    status_filter = citic_prudential_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    page_meta = {
        "url": CITIC_PRUDENTIAL_PRODUCT_INFO_URL,
        "status": 0,
        "label": "互联网产品信息",
        "salesStatus": "、".join(sorted(status_filter)),
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    status, html = fetch_html_direct(CITIC_PRUDENTIAL_PRODUCT_INFO_URL, referer="https://www.citic-prudential.com.cn/")
    page_meta["status"] = status
    if status < 200 or status >= 300 or "互联网产品信息" not in html:
        return {"ok": False, "company": company, "pages": [page_meta], "products": [], "records": []}
    tasks, total_candidate_products = citic_prudential_material_tasks_from_page(company, html, status_filter)
    page_meta["productCount"] = total_candidate_products
    page_meta["materialTaskCount"] = len(tasks)
    selected_tasks = tasks[offset:]
    if max_products:
        selected_tasks = selected_tasks[:max_products]
    products = [
        {
            "company": company,
            "productName": trim(task.get("productName")),
            "productType": trim(task.get("productType")),
            "salesStatus": trim(task.get("salesStatus")),
            "sourcePage": trim(task.get("sourcePage")),
            "clauseCode": trim(task.get("clauseCode")),
        }
        for task in selected_tasks
    ]
    records = crawl_citic_prudential_material_records(selected_tasks, max_workers=max_workers)
    page_meta["recordCount"] = len(records)
    return {
        "ok": True,
        "company": company,
        "source": CITIC_PRUDENTIAL_PRODUCT_INFO_URL,
        "officialDomain": CITIC_PRUDENTIAL_OFFICIAL_DOMAIN,
        "officialDomains": sorted(CITIC_PRUDENTIAL_OFFICIAL_DOMAINS),
        "saleStatus": sorted(status_filter),
        "offset": offset,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "totalCandidateProductCount": total_candidate_products,
        "pages": [page_meta],
        "products": products,
        "materialTaskCount": len(selected_tasks),
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
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
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
        **archive_pdf_bytes(data, pdf_archive_dir, material_url),
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
    offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    max_detail_workers = max(1, int(payload.get("maxDetailWorkers") or payload.get("detailConcurrency") or max_workers))
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
    pages: list[dict[str, Any]] = []
    products: list[dict[str, str]] = []
    seen_products: set[str] = set()
    skipped_products = 0

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
                if skipped_products < offset:
                    skipped_products += 1
                    continue
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
            task["pdfArchiveDir"] = pdf_archive_dir
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
        "offset": offset,
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
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


def dingcheng_life_source_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {page["key"] for page in DINGCHENG_LIFE_PRODUCT_PAGES}
    selected: set[str] = set()
    for part in re.split(r"[,，\s]+", text):
        if part in {"in_sale", "sale", "active", "在售", "zscp"}:
            selected.add("in_sale")
        elif part in {"stopped", "stop", "停售", "tscp"}:
            selected.add("stopped")
        elif part in {"internet", "online", "互联网", "互联网保险", "互联网披露"}:
            selected.add("internet")
    return selected or {page["key"] for page in DINGCHENG_LIFE_PRODUCT_PAGES}


def dingcheng_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return set()
    if text in {"in_sale", "sale", "active", "在售", "y"}:
        return {"在售"}
    if text in {"stopped", "stop", "停售", "n"}:
        return {"停售", "停止互联网销售产品"}
    if text in {"internet", "online", "互联网", "互联网保险", "互联网披露"}:
        return {"互联网保险披露", "停止互联网销售产品"}
    return {trim(value)}


def dingcheng_life_official_url(url: str) -> bool:
    try:
        hostname = (urlsplit(url).hostname or "").lower()
    except Exception:
        return False
    return hostname in DINGCHENG_LIFE_OFFICIAL_DOMAINS


def dingcheng_life_normalize_url(href: str, page_url: str) -> str:
    raw = trim(href)
    if not raw:
        return ""
    candidate = urljoin(page_url, raw)
    if not dingcheng_life_official_url(candidate):
        return ""
    return candidate


def dingcheng_life_product_type(product_name: str, fallback: str = "") -> str:
    name = trim(product_name)
    labels: list[str] = []
    if "投连" in name or "投资连结" in name:
        labels.append("投连险")
    if "万能" in name:
        labels.append("万能账户")
    if "护理" in name:
        labels.append("护理险")
    if "医疗" in name or "住院" in name or "费用补偿" in name:
        labels.append("医疗险")
    if "重大疾病" in name or "疾病" in name or "防癌" in name or "恶性肿瘤" in name:
        labels.append("重疾险")
    if "意外" in name:
        labels.append("意外险")
    if "年金" in name or "养老" in name:
        labels.append("年金险")
    if "两全" in name:
        labels.append("两全保险")
    if "定期寿险" in name:
        labels.append("定期寿险")
    if "增额" in name and "终身寿险" in name:
        labels.append("增额终身寿险")
    if not labels and trim(fallback) and trim(fallback) not in {"P1", "P2", "P3"}:
        labels.append(trim(fallback))
    return "、".join(dict.fromkeys(labels)) or "其他"


def dingcheng_life_material_type(header: str, label: str = "") -> str:
    text = clean_text(f"{header} {label}")
    if "说明书" in text or "产品说明" in text:
        return "product_manual"
    return "terms"


def dingcheng_life_table_status(page: dict[str, str], table: Any) -> str:
    if trim(page.get("key")) != "internet":
        return trim(page.get("defaultSalesStatus")) or "未标明"
    previous_texts: list[str] = []
    node = table
    for _ in range(10):
        node = node.find_previous()
        if not node:
            break
        text = html_text(str(node))
        if text and len(text) < 160:
            previous_texts.append(text)
    context = " ".join(previous_texts)
    if "停止互联网销售产品" in context or "停售" in context:
        return "停止互联网销售产品"
    if "产品信息" in context:
        return "互联网保险披露"
    return trim(page.get("defaultSalesStatus")) or "互联网保险披露"


def dingcheng_life_parse_page(
    company: str,
    page: dict[str, str],
    html: str,
    *,
    seen_urls: set[str],
    skip_urls: set[str],
    product_offset: int,
    max_products: int,
    accepted_product_count: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], int, dict[str, Any]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    page_product_count = 0
    skipped_by_offset = 0
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) < 2:
            continue
        headers = [html_text(str(cell)) for cell in rows[0].find_all(["td", "th"])]
        product_index = next(
            (index for index, header in enumerate(headers) if header in {"产品名称", "保险产品名称"}),
            -1,
        )
        material_indices = {
            index: header
            for index, header in enumerate(headers)
            if header in {"产品条款", "条款", "产品说明书"}
        }
        if product_index < 0 or not material_indices:
            continue
        table_status = dingcheng_life_table_status(page, table)
        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) <= product_index:
                continue
            product_name = html_text(str(cells[product_index])).replace("\ufeff", "")
            if not product_name or product_name in {"产品名称", "保险产品名称"}:
                continue
            row_materials: list[dict[str, str]] = []
            for index, header in material_indices.items():
                if len(cells) <= index:
                    continue
                for anchor in cells[index].find_all("a"):
                    label = html_text(str(anchor))
                    material_url = dingcheng_life_normalize_url(trim(anchor.get("href")), page["url"])
                    if not label or not material_url:
                        continue
                    if EXCLUDED_MATERIAL_RE.search(f"{header} {label} {material_url}"):
                        continue
                    row_materials.append(
                        {
                            "label": "产品说明书" if "说明" in header else "保险条款",
                            "title": label,
                            "type": dingcheng_life_material_type(header, label),
                            "url": material_url,
                        }
                    )
            if not row_materials:
                continue
            page_product_count += 1
            if skipped_by_offset < product_offset:
                skipped_by_offset += 1
                continue
            if max_products and accepted_product_count >= max_products:
                break
            accepted_product_count += 1
            product_type_hint = html_text(str(cells[headers.index("产品分类")])) if "产品分类" in headers and len(cells) > headers.index("产品分类") else ""
            product = {
                "company": company,
                "productName": product_name,
                "productType": dingcheng_life_product_type(product_name, product_type_hint),
                "salesStatus": table_status,
                "sourcePage": page["url"],
                "sourceStatus": trim(page.get("key")),
                "pageLabel": trim(page.get("label")),
            }
            products.append(product)
            for material in row_materials:
                material_url = material["url"]
                if material_url in seen_urls or material_url in skip_urls:
                    continue
                seen_urls.add(material_url)
                tasks.append(
                    {
                        **product,
                        "label": material["label"],
                        "materialType": material["type"],
                        "title": material["title"],
                        "url": material_url,
                    }
                )
        if max_products and accepted_product_count >= max_products:
            break
    page_meta = {
        "url": page["url"],
        "status": 200 if html else 0,
        "label": trim(page.get("label")),
        "sourceStatus": trim(page.get("key")),
        "productCount": page_product_count,
        "materialTaskCount": len(tasks),
    }
    return products, tasks, accepted_product_count, page_meta


def dingcheng_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "blank_or_placeholder"
    if not has_actual_responsibility_text(text):
        return "invalid_non_responsibility", "no_actual_responsibility_text"
    if re.search(r"^(保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外)", text):
        return "valid_partial", "starts_mid_clause"
    return "valid_complete", ""


def crawl_dingcheng_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not material_url or not dingcheng_life_official_url(material_url):
        return None
    pdf_status, content_type, data = fetch_binary_direct(
        material_url,
        referer=trim(task.get("sourcePage")) or DINGCHENG_LIFE_OFFICIAL_BASE_URL,
    )
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    status, issue = dingcheng_life_quality(page_text)
    if status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "保险条款"
    title = trim(task.get("title")) or f"{product_name}{label}"
    host = (urlsplit(material_url).hostname or "").lower()
    return {
        "company": trim(task.get("company")) or "鼎诚人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or dingcheng_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": title,
        "url": material_url,
        "snippet": f"鼎诚人寿官网{trim(task.get('pageLabel'))}{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or dingcheng_life_material_type(label, title),
        "official": True,
        "officialDomain": host,
        "parser": "scrapling_dingcheng_life_product_info",
        "qualityStatus": status,
        "qualityReason": issue,
        "responsibilityQualityStatus": status,
        "responsibilityQualityIssue": issue,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "sourcePage": trim(task.get("sourcePage")),
        "sourceStatus": trim(task.get("sourceStatus")),
    }


def crawl_dingcheng_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "鼎诚人寿"
    source_filter = dingcheng_life_source_filter(trim(payload.get("sourceScope") or payload.get("source")))
    status_filter = dingcheng_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("salesStatus")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    seen_urls: set[str] = set()
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    accepted_product_count = 0
    for page in DINGCHENG_LIFE_PRODUCT_PAGES:
        if page["key"] not in source_filter:
            continue
        page_status, html = fetch_html_direct(page["url"], referer=DINGCHENG_LIFE_OFFICIAL_BASE_URL)
        page_products, page_tasks, accepted_product_count, page_meta = dingcheng_life_parse_page(
            company,
            page,
            html if page_status >= 200 and page_status < 300 else "",
            seen_urls=seen_urls,
            skip_urls=skip_urls,
            product_offset=product_offset,
            max_products=max_products,
            accepted_product_count=accepted_product_count,
        )
        if status_filter:
            page_products = [product for product in page_products if trim(product.get("salesStatus")) in status_filter]
            page_tasks = [task for task in page_tasks if trim(task.get("salesStatus")) in status_filter]
            page_meta["materialTaskCount"] = len(page_tasks)
        products.extend(page_products)
        tasks.extend(page_tasks)
        page_meta["status"] = page_status
        pages.append(page_meta)
        if max_products and accepted_product_count >= max_products:
            break
    records: list[dict[str, Any]] = []
    if max_workers <= 1:
        for task in tasks:
            record = crawl_dingcheng_life_material_record(task)
            if record:
                records.append(record)
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(crawl_dingcheng_life_material_record, task) for task in tasks]
            for future in as_completed(futures):
                record = future.result()
                if record:
                    records.append(record)
    counts_by_page: dict[str, int] = {}
    for record in records:
        source_page = trim(record.get("sourcePage"))
        counts_by_page[source_page] = counts_by_page.get(source_page, 0) + 1
    for page in pages:
        page["recordCount"] = counts_by_page.get(trim(page.get("url")), 0)
    return {
        "ok": True,
        "company": company,
        "source": DINGCHENG_LIFE_OFFICIAL_BASE_URL,
        "officialDomain": ",".join(sorted(DINGCHENG_LIFE_OFFICIAL_DOMAINS)),
        "sourceScope": sorted(source_filter),
        "saleStatus": sorted(status_filter) if status_filter else ["all"],
        "maxProducts": max_products,
        "productOffset": product_offset,
        "maxWorkers": max_workers,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
        "pages": pages,
    }


def pku_founder_life_seed_terms(payload: dict[str, Any]) -> list[dict[str, str]]:
    terms = PKU_FOUNDER_LIFE_TERMS
    return [
        {
            "company": trim(payload.get("company")) or "北大方正人寿",
            "productName": item["productName"],
            "productType": item["productType"],
            "salesStatus": item["salesStatus"],
            "title": item["title"],
            "url": item["url"],
            "sourcePage": item["sourcePage"],
            "label": "条款",
            "materialType": "terms",
        }
        for item in terms
    ]


def pku_founder_life_official_url(url: str) -> bool:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except Exception:
        return False
    return host in PKU_FOUNDER_LIFE_OFFICIAL_DOMAINS


def pku_founder_life_normalize_material_url(url: str) -> str:
    value = trim(url)
    if not value:
        return ""
    full_url = urljoin(PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL, value)
    parts = urlsplit(full_url)
    host = (parts.hostname or "").lower()
    if host == PKU_FOUNDER_LIFE_ASSET_DOMAIN:
        return urlunsplit(("https", parts.netloc, parts.path, parts.query, parts.fragment))
    return full_url


def pku_founder_life_fetch_json(url: str) -> dict[str, Any]:
    status, text = fetch_html_direct(url, referer=PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL)
    if status < 200 or status >= 300 or not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        return {}


def pku_founder_life_sale_status_filter(value: str) -> set[str]:
    normalized = trim(value).lower()
    if normalized in {"", "all", "全部"}:
        return {"在售", "停售", "互联网保险披露", "公开披露"}
    if normalized in {"in_sale", "sale", "active", "在售", "y", "1"}:
        return {"在售"}
    if normalized in {"stopped", "stop", "停售", "n", "0"}:
        return {"停售"}
    if normalized in {"internet", "internet_disclosure", "互联网", "互联网保险披露"}:
        return {"互联网保险披露"}
    if normalized in {"seed", "公开披露"}:
        return {"公开披露"}
    return {value}


def pku_founder_life_source_filter(value: str) -> set[str]:
    normalized = trim(value).lower()
    if normalized in {"", "all", "全部"}:
        return {"regular", "internet", "seed"}
    selected: set[str] = set()
    for part in re.split(r"[,，\s]+", normalized):
        if part in {"regular", "product", "products", "产品", "披露产品"}:
            selected.add("regular")
        elif part in {"internet", "互联网", "internet_disclosure"}:
            selected.add("internet")
        elif part in {"seed", "manual", "known", "已知"}:
            selected.add("seed")
    return selected or {"regular", "internet", "seed"}


def pku_founder_life_archive_material_from_filename(filename: str, fallback_type: str = "") -> dict[str, str] | None:
    value = trim(filename)
    try:
        decoded = value.encode("cp437").decode("gbk")
    except Exception:
        decoded = value
    basename = re.split(r"[/\\]+", decoded)[-1]
    lower = basename.lower()
    if not lower.endswith(".pdf"):
        return None
    excluded = r"费率|保险费率|现金价值|现价|利益演示|账户价值|投保单|投保须知|投保提示|告知书|健康告知|声明|授权|申请书|批复|报送材料|材料清单|编码信息|备案表|变更说明"
    if re.search(excluded, basename, re.I):
        return None
    title = re.sub(r"\.pdf$", "", basename, flags=re.I)
    if "产品说明书" in basename or "产品说明" in basename:
        return {"label": "产品说明书", "materialType": "product_manual", "title": title}
    if "保险条款" in basename or "利益条款" in basename or "条款" in basename:
        return {"label": "保险条款", "materialType": "terms", "title": title}
    if fallback_type in {"terms", "product_manual"}:
        label = "产品说明书" if fallback_type == "product_manual" else "保险条款"
        return {"label": label, "materialType": fallback_type, "title": title}
    return None


def pku_founder_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "blank_or_placeholder"
    if not has_actual_responsibility_text(text):
        return "invalid_non_responsibility", "no_actual_responsibility_text"
    if re.search(r"^(保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外)", text):
        return "valid_partial", "starts_mid_clause"
    return "valid_complete", ""


def pku_founder_life_record_from_pdf(
    task: dict[str, str],
    material_url: str,
    data: bytes,
    content_type: str = "",
    source_type: str = "pdf",
    entry_name: str = "",
    archive_material: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    status, issue = pku_founder_life_quality(page_text)
    if status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim((archive_material or {}).get("label")) or trim(task.get("label")) or "保险条款"
    material_type_value = trim((archive_material or {}).get("materialType")) or trim(task.get("materialType")) or "terms"
    title = trim((archive_material or {}).get("title")) or trim(task.get("title")) or f"{product_name}{label}"
    host = (urlsplit(material_url.split("#", 1)[0]).hostname or "").lower()
    return {
        "company": trim(task.get("company")) or "北大方正人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or taikang_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")) or "公开披露",
        "title": title,
        "url": material_url,
        "snippet": f"北大方正人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": source_type,
        "materialType": material_type_value,
        "official": True,
        "officialDomain": host,
        "parser": "scrapling_pku_founder_life_product_info",
        "qualityStatus": status,
        "qualityReason": issue,
        "responsibilityQualityStatus": status,
        "responsibilityQualityIssue": issue,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "archiveEntry": entry_name,
        "sourcePage": trim(task.get("sourcePage")),
        "sourceList": trim(task.get("sourceList")),
        "sourceProductId": trim(task.get("sourceProductId")),
    }


def pku_founder_life_records_from_zip(task: dict[str, str], data: bytes, content_type: str = "") -> list[dict[str, Any]]:
    if not data or len(data) > MAX_ZIP_BYTES or not data.startswith(b"PK"):
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
        material = pku_founder_life_archive_material_from_filename(info.filename, trim(task.get("fallbackMaterialType")))
        if not material or info.file_size <= 0 or info.file_size > MAX_PDF_BYTES:
            continue
        try:
            pdf_bytes = archive.read(info)
        except Exception:
            continue
        if len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF"):
            continue
        entry_name = trim(material.get("title")) or trim(info.filename)
        material_url = f"{archive_url}#entry={quote(entry_name, safe='')}"
        record = pku_founder_life_record_from_pdf(task, material_url, pdf_bytes, content_type, "archive_pdf", entry_name, material)
        if record:
            records.append(record)
    return records


def pku_founder_life_product_entries(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[dict[str, Any]]]:
    company = trim(payload.get("company")) or "北大方正人寿"
    source_filter = pku_founder_life_source_filter(trim(payload.get("sourceScope") or payload.get("source")))
    status_filter = pku_founder_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("salesStatus")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("offset") or payload.get("productOffset") or 0))
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []

    def add_material_task(product: dict[str, Any], label: str, material_type_value: str, url: str, source_kind: str = "pdf") -> None:
        material_url = pku_founder_life_normalize_material_url(url)
        if not material_url or not pku_founder_life_official_url(material_url):
            return
        lower_path = urlsplit(material_url).path.lower()
        if source_kind == "archive":
            if not lower_path.endswith(".zip"):
                return
        elif not lower_path.endswith(".pdf"):
            return
        tasks.append(
            {
                "company": company,
                "productName": trim(product.get("productName")),
                "productType": trim(product.get("productType")),
                "salesStatus": trim(product.get("salesStatus")),
                "title": trim(product.get("title")) or f"{trim(product.get('productName'))}{label}",
                "label": label,
                "materialType": material_type_value,
                "url": material_url,
                "sourcePage": trim(product.get("sourcePage")),
                "sourceList": trim(product.get("sourceList")),
                "sourceProductId": str(product.get("sourceProductId") or ""),
                "sourceKind": source_kind,
            }
        )

    regular_rows: list[dict[str, Any]] = []
    if "regular" in source_filter:
        for sell_flag, sales_status in (("1", "在售"), ("0", "停售")):
            data = pku_founder_life_fetch_json(f"{PKU_FOUNDER_LIFE_PRODUCT_INFO_URL}?sellFlag={sell_flag}")
            rows = data.get("data") if isinstance(data.get("data"), list) else []
            regular_rows.extend({**row, "salesStatus": sales_status, "sourceList": "regular"} for row in rows)
            pages.append(
                {
                    "url": f"{PKU_FOUNDER_LIFE_PRODUCT_INFO_URL}?sellFlag={sell_flag}",
                    "status": 200 if rows else 0,
                    "salesStatus": sales_status,
                    "productCount": len(rows),
                }
            )
    internet_rows: list[dict[str, Any]] = []
    if "internet" in source_filter:
        data = pku_founder_life_fetch_json(PKU_FOUNDER_LIFE_INTERNET_PRODUCT_URL)
        page_data = data.get("data") if isinstance(data.get("data"), dict) else {}
        rows = page_data.get("records") if isinstance(page_data.get("records"), list) else []
        internet_rows = [{**row, "salesStatus": "互联网保险披露", "sourceList": "internet"} for row in rows]
        pages.append(
            {
                "url": PKU_FOUNDER_LIFE_INTERNET_PRODUCT_URL,
                "status": 200 if rows else 0,
                "salesStatus": "互联网保险披露",
                "productCount": len(rows),
                "total": page_data.get("total", len(rows)),
                "pages": page_data.get("pages", 1),
            }
        )

    source_rows = [row for row in [*regular_rows, *internet_rows] if trim(row.get("salesStatus")) in status_filter]
    if product_offset:
        source_rows = source_rows[product_offset:]
    if max_products:
        source_rows = source_rows[:max_products]
    for row in source_rows:
        product_name = trim(row.get("name"))
        if not product_name:
            continue
        product = {
            "company": company,
            "productName": product_name,
            "productType": taikang_life_product_type(product_name),
            "salesStatus": trim(row.get("salesStatus")),
            "sourcePage": PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL,
            "sourceList": trim(row.get("sourceList")),
            "sourceProductId": row.get("id"),
        }
        products.append(product)
        term_url = trim(row.get("termUrl"))
        filings_url = trim(row.get("filingsUrl"))
        product_instruction_url = trim(row.get("productInstructionUrl"))
        product_desc_url = trim(row.get("productDescUrl"))
        if term_url:
            add_material_task(product, "保险条款", "terms", term_url, "pdf")
        if filings_url:
            add_material_task(product, "备案资料包", "archive", filings_url, "archive")
        if product_instruction_url and not term_url and not filings_url:
            add_material_task(product, "产品说明书", "product_manual", trim(row.get("productInstructionUrl")), "pdf")
        if product_desc_url and not term_url and not filings_url:
            add_material_task(product, "产品说明书", "product_manual", trim(row.get("productDescUrl")), "pdf")

    if "seed" in source_filter and "公开披露" in status_filter:
        seed_tasks = pku_founder_life_seed_terms({**payload, "company": company})
        tasks.extend(seed_tasks)
        products.extend(
            {
                "company": company,
                "productName": task["productName"],
                "productType": task["productType"],
                "salesStatus": task["salesStatus"],
                "sourcePage": task["sourcePage"],
                "sourceList": "seed",
                "sourceProductId": "",
            }
            for task in seed_tasks
        )
        pages.append(
            {
                "url": PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL,
                "status": 200,
                "salesStatus": "公开披露",
                "productCount": len(seed_tasks),
            }
        )

    for page in pages:
        page["materialTaskCount"] = len([task for task in tasks if trim(task.get("salesStatus")) == trim(page.get("salesStatus"))])
    return products, tasks, pages


def crawl_pku_founder_life_material_record(task: dict[str, str]) -> list[dict[str, Any]]:
    material_url = trim(task.get("url"))
    if not material_url or not pku_founder_life_official_url(material_url):
        return []
    referer = trim(task.get("sourcePage")) or PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL
    if trim(task.get("sourceKind")) == "archive" or urlsplit(material_url).path.lower().endswith(".zip"):
        status, content_type, data = fetch_binary_direct(material_url, referer=referer, max_bytes=MAX_ZIP_BYTES)
        if status < 200 or status >= 300 or len(data) > MAX_ZIP_BYTES:
            return []
        return pku_founder_life_records_from_zip(task, data, content_type)
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=referer)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return []
    record = pku_founder_life_record_from_pdf(task, material_url, data, content_type, "pdf")
    return [record] if record else []


def crawl_pku_founder_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "北大方正人寿"
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 2))
    products, tasks, pages = pku_founder_life_product_entries({**payload, "company": company})
    records: list[dict[str, Any]] = []
    if max_workers <= 1:
        for task in tasks:
            records.extend(crawl_pku_founder_life_material_record(task))
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(crawl_pku_founder_life_material_record, task) for task in tasks]
            for future in as_completed(futures):
                records.extend(future.result())
    record_counts_by_status: dict[str, int] = {}
    for record in records:
        status = trim(record.get("salesStatus"))
        record_counts_by_status[status] = record_counts_by_status.get(status, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_status.get(trim(page.get("salesStatus")), 0)
    return {
        "ok": True,
        "company": company,
        "source": PKU_FOUNDER_LIFE_OFFICIAL_BASE_URL,
        "officialDomain": ",".join(sorted(PKU_FOUNDER_LIFE_OFFICIAL_DOMAINS)),
        "maxWorkers": max_workers,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
        "pages": pages,
    }


def boc_samsung_life_sm4_cipher():
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        return Cipher(algorithms.SM4(bytes.fromhex(BOC_SAMSUNG_LIFE_SM4_KEY_HEX)), modes.ECB())
    except Exception as error:
        raise RuntimeError(f"cryptography SM4 unavailable: {error}") from error


def boc_samsung_life_pkcs7_pad(data: bytes) -> bytes:
    size = 16 - (len(data) % 16)
    return data + bytes([size]) * size


def boc_samsung_life_pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        return data
    size = data[-1]
    if 1 <= size <= 16 and data.endswith(bytes([size]) * size):
        return data[:-size]
    return data


def boc_samsung_life_encrypt(value: str) -> str:
    encryptor = boc_samsung_life_sm4_cipher().encryptor()
    data = boc_samsung_life_pkcs7_pad(value.encode("utf-8"))
    return (encryptor.update(data) + encryptor.finalize()).hex()


def boc_samsung_life_decrypt(value: str) -> str:
    decryptor = boc_samsung_life_sm4_cipher().decryptor()
    data = bytes.fromhex(value)
    output = decryptor.update(data) + decryptor.finalize()
    return boc_samsung_life_pkcs7_unpad(output).decode("utf-8", "ignore")


def boc_samsung_life_api_headers(referer: str, encrypted_body: str = "") -> list[str]:
    timestamp = str(int(time.time() * 1000))
    request_uuid = str(uuid.uuid4())
    headers = [
        "-H",
        "Content-Type: application/json;charset=UTF-8",
        "-H",
        f"Referer: {referer}",
        "-H",
        f"REQUESTCHECKKEY: REQUEST_CHECK_VALUE_{timestamp}",
        "-H",
        f"X-Timestamp: {timestamp}",
        "-H",
        f"X-Uuid: {request_uuid}",
        "-H",
        f"X-Sign: {boc_samsung_life_encrypt(timestamp + request_uuid)}",
    ]
    if encrypted_body:
        signature = hmac.new(BOC_SAMSUNG_LIFE_HMAC_KEY.encode("utf-8"), encrypted_body.encode("utf-8"), hashlib.sha256).hexdigest()
        headers.extend(["-H", f"X-Api-Sign: {signature}"])
    return headers


def boc_samsung_life_post_api(url: str, payload: dict[str, Any], referer: str) -> tuple[int, dict[str, Any]]:
    encrypted = boc_samsung_life_encrypt(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    proc = subprocess.run(
        [
            "curl",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            *boc_samsung_life_api_headers(referer, encrypted),
            "-d",
            json.dumps({"en": encrypted}, separators=(",", ":")),
            url,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, {}
    try:
        response = json.loads(proc.stdout.decode("utf-8", "ignore"))
        if isinstance(response.get("data"), str):
            response["data"] = json.loads(boc_samsung_life_decrypt(response["data"]))
        return int(response.get("status") or 200), response
    except Exception:
        return 0, {}


def boc_samsung_life_get_api(url: str, referer: str) -> tuple[int, dict[str, Any]]:
    empty_query = boc_samsung_life_encrypt("")
    separator = "&" if "?" in url else "?"
    proc = subprocess.run(
        [
            "curl",
            "-L",
            "-sS",
            "--max-time",
            "30",
            "--user-agent",
            "Mozilla/5.0",
            *boc_samsung_life_api_headers(referer),
            f"{url}{separator}en={empty_query}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, {}
    try:
        response = json.loads(proc.stdout.decode("utf-8", "ignore"))
        if isinstance(response.get("data"), str):
            response["data"] = json.loads(boc_samsung_life_decrypt(response["data"]))
        return int(response.get("status") or 200), response
    except Exception:
        return 0, {}


def boc_samsung_life_official_url(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
    except Exception:
        return False
    return host == "boc-samsunglife.cn" or host.endswith(".boc-samsunglife.cn")


def boc_samsung_life_product_type(product_name: str, goods_type: str = "") -> str:
    product_type = taikang_life_product_type(product_name)
    if product_type:
        return product_type
    if goods_type == "2":
        return "医疗险"
    if goods_type == "3":
        return "意外险"
    return "其他"


def boc_samsung_life_material_type(label: str) -> str:
    text = trim(label)
    if "条款" in text:
        return "terms"
    if "产品说明书" in text or "产品说明" in text:
        return "product_manual"
    return ""


def boc_samsung_life_products(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    page_size = int(payload.get("pageSize") or 20)
    status, response = boc_samsung_life_post_api(
        BOC_SAMSUNG_LIFE_PRODUCT_LIST_ENDPOINT,
        {"pageNum": 1, "pageSize": page_size, "queryBean": {"moudleCode": "BOC_BX", "goodsType": "", "salesGroup": ""}},
        "https://www.boc-samsunglife.cn/products",
    )
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    products = data.get("list") or []
    return products, {
        "url": BOC_SAMSUNG_LIFE_PRODUCT_LIST_ENDPOINT,
        "status": status,
        "productCount": len(products),
        "total": data.get("total") or len(products),
        "pageSize": data.get("pageSize") or page_size,
    }


def boc_samsung_life_product_detail(goods_id: int) -> tuple[int, dict[str, Any]]:
    status, response = boc_samsung_life_get_api(
        f"{BOC_SAMSUNG_LIFE_GOODS_DETAIL_ENDPOINT}/{goods_id}",
        f"https://www.boc-samsunglife.cn/ProductDetail/{goods_id}",
    )
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    return status, data


def boc_samsung_life_ocr_image_bytes(data: bytes) -> str:
    if not data:
        return ""
    swift_code = r'''
import AppKit
import Foundation
import Vision

let imagePath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  exit(1)
}
let width = cgImage.width
let height = cgImage.height
let sliceHeight = 2200
var output: [String] = []
for y in stride(from: 0, to: height, by: sliceHeight) {
  let h = min(sliceHeight, height - y)
  guard let crop = cgImage.cropping(to: CGRect(x: 0, y: y, width: width, height: h)) else { continue }
  var lines: [String] = []
  let request = VNRecognizeTextRequest { request, error in
    let observations = request.results as? [VNRecognizedTextObservation] ?? []
    lines = observations.compactMap {
      $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }
  }
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  let handler = VNImageRequestHandler(cgImage: crop, options: [:])
  try? handler.perform([request])
  output.append(contentsOf: lines)
}
print(output.joined(separator: "\n"))
'''
    with tempfile.NamedTemporaryFile(prefix="boc-samsung-terms-", suffix=".png") as image_file:
        image_file.write(data)
        image_file.flush()
        proc = subprocess.run(
            ["swift", "-", image_file.name],
            input=swift_code,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=120,
        )
    return proc.stdout if proc.returncode == 0 else ""


def boc_samsung_life_terms_text(material_url: str) -> tuple[str, dict[str, Any]]:
    status, content_type, data = fetch_binary_direct(material_url, referer=BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL, max_bytes=MAX_PDF_BYTES)
    meta = {"status": status, "contentType": content_type, "bytes": len(data), "sourceType": "html"}
    if status < 200 or status >= 300 or not data:
        return "", meta
    if data.startswith(b"%PDF"):
        extracted = extract_pdf_text_with_system_python(data)
        meta.update({"sourceType": "pdf", "pages": extracted.get("pages", 0)})
        return extracted.get("text", ""), meta
    html = data.decode("utf-8", "ignore")
    text = html_text(html)
    soup = BeautifulSoup(html, "html.parser")
    image_texts: list[str] = []
    for image in soup.find_all("img"):
        image_url = urljoin(material_url, trim(image.get("src")))
        if not boc_samsung_life_official_url(image_url):
            continue
        if urlsplit(image_url).scheme == "http":
            image_url = urlunsplit(("https", urlsplit(image_url).netloc, urlsplit(image_url).path, urlsplit(image_url).query, urlsplit(image_url).fragment))
        image_status, image_content_type, image_data = fetch_binary_direct(image_url, referer=material_url, max_bytes=MAX_PDF_BYTES)
        if image_status >= 200 and image_status < 300 and image_data:
            image_text = boc_samsung_life_ocr_image_bytes(image_data)
            if image_text:
                image_texts.append(image_text)
            meta.update({"imageUrl": image_url, "imageContentType": image_content_type, "imageBytes": len(image_data)})
    return "\n".join([text, *image_texts]).strip(), meta


def boc_samsung_life_material_tasks(company: str, detail: dict[str, Any]) -> list[dict[str, Any]]:
    product_name = trim(detail.get("goodsName"))
    goods_id = int(detail.get("id") or 0)
    product_type = boc_samsung_life_product_type(product_name, trim(detail.get("goodsType")))
    tasks: list[dict[str, Any]] = []
    for item in detail.get("productFileDTOList") or []:
        label = trim(item.get("fileName"))
        material_type_value = boc_samsung_life_material_type(label)
        if material_type_value != "terms":
            continue
        material_url = urljoin(BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL, trim(item.get("url")))
        if not boc_samsung_life_official_url(material_url):
            continue
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product_type,
                "salesStatus": "在售",
                "title": f"{product_name}{label}",
                "label": label,
                "materialType": material_type_value,
                "url": material_url,
                "sourcePage": f"https://www.boc-samsunglife.cn/ProductDetail/{goods_id}",
                "goodsId": goods_id,
            }
        )
    return tasks


def crawl_boc_samsung_life_material_record(task: dict[str, Any]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not boc_samsung_life_official_url(material_url):
        return None
    raw_text, meta = boc_samsung_life_terms_text(material_url)
    page_text = focused_responsibility_excerpt(raw_text)
    if not page_text or "保险责任" not in page_text:
        return None
    return {
        "company": trim(task.get("company")) or "中银三星人寿",
        "productName": trim(task.get("productName")),
        "productType": trim(task.get("productType")) or boc_samsung_life_product_type(trim(task.get("productName"))),
        "salesStatus": trim(task.get("salesStatus")) or "在售",
        "title": trim(task.get("title")),
        "url": material_url,
        "snippet": "中银三星人寿官网保险条款，HTML 长图经本机 OCR 后截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": meta.get("sourceType") or "html",
        "materialType": trim(task.get("materialType")) or "terms",
        "official": True,
        "officialDomain": urlsplit(material_url).hostname or BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_boc_samsung_life_product_info",
        "qualityStatus": "valid_complete",
        "qualityReason": "",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "sourcePage": trim(task.get("sourcePage")),
        "bytes": meta.get("bytes", 0),
        "contentType": meta.get("contentType", ""),
        "imageUrl": meta.get("imageUrl", ""),
        "imageBytes": meta.get("imageBytes", 0),
    }


def crawl_boc_samsung_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中银三星人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    products, page_meta = boc_samsung_life_products(payload)
    if max_products:
        products = products[:max_products]
    normalized_products: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    detail_pages: list[dict[str, Any]] = []
    for product in products:
        goods_id = int(product.get("id") or product.get("goodsListViewDTO", {}).get("goodsId") or 0)
        if not goods_id:
            continue
        status, detail = boc_samsung_life_product_detail(goods_id)
        product_name = trim(detail.get("goodsName"))
        detail_tasks = boc_samsung_life_material_tasks(company, detail) if product_name else []
        normalized_products.append(
            {
                "company": company,
                "productName": product_name,
                "productType": boc_samsung_life_product_type(product_name, trim(detail.get("goodsType"))),
                "salesStatus": "在售",
                "sourcePage": f"https://www.boc-samsunglife.cn/ProductDetail/{goods_id}",
                "goodsId": goods_id,
            }
        )
        tasks.extend(detail_tasks)
        detail_pages.append(
            {
                "url": f"{BOC_SAMSUNG_LIFE_GOODS_DETAIL_ENDPOINT}/{goods_id}",
                "status": status,
                "productName": product_name,
                "materialTaskCount": len(detail_tasks),
            }
        )
    records = [record for record in (crawl_boc_samsung_life_material_record(task) for task in tasks) if record]
    return {
        "ok": True,
        "company": company,
        "source": BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL,
        "officialDomain": BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN,
        "products": normalized_products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
        "pages": [page_meta, *detail_pages],
    }


def bsl_product_info_type(product_name: str) -> str:
    if "重大疾病" in product_name or "疾病" in product_name or "防癌" in product_name or "癌" in product_name:
        return "重疾险"
    if "医疗" in product_name or "住院" in product_name or "津贴" in product_name:
        return "医疗险"
    if "意外" in product_name or "交通" in product_name:
        return "意外险"
    if "年金" in product_name or "养老" in product_name:
        return "年金险"
    if "两全" in product_name:
        return "两全保险"
    if "定期寿险" in product_name:
        return "定期寿险"
    if "终身寿险" in product_name:
        return "增额终身寿险"
    if "万能" in product_name:
        return "万能账户"
    if "投连" in product_name or "投资连结" in product_name:
        return "投连险"
    if "护理" in product_name:
        return "护理险"
    return "其他"


def bsl_product_info_material_type(label: str) -> str:
    if BOC_SAMSUNG_LIFE_EXCLUDED_MATERIAL_RE.search(label):
        return ""
    if "产品说明" in label or "说明书" in label:
        return "product_manual"
    if "条款" in label:
        return "terms"
    return ""


def bsl_product_info_material_url(value: str) -> str:
    material_url = urljoin(BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL, trim(value))
    host = (urlsplit(material_url).hostname or "").lower()
    if host != BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN or ".pdf" not in material_url.lower():
        return ""
    return material_url


def bsl_product_info_status(item: dict[str, Any]) -> str:
    state = trim(item.get("state"))
    if state in {"1", "在售", "Y"}:
        return "在售"
    if state in {"0", "3", "停售", "N"}:
        return "停售"
    return "公开披露"


def bsl_product_info_fetch_page(page_number: int, page_size: int) -> tuple[int, dict[str, Any]]:
    status, response = boc_samsung_life_post_api(
        BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT,
        {"pageNum": page_number, "pageSize": page_size, "queryBean": {}},
        "https://www.boc-samsunglife.cn/Information",
    )
    return status, response.get("data") if isinstance(response.get("data"), dict) else {}


def bsl_product_info_tasks_from_item(company: str, item: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    product_name = trim(item.get("productName"))
    if not product_name:
        return None, []
    product = {
        "company": company,
        "productName": product_name,
        "productType": bsl_product_info_type(product_name),
        "salesStatus": bsl_product_info_status(item),
        "sourcePage": "https://www.boc-samsunglife.cn/Information",
        "productCode": trim(item.get("productCode")),
        "sourceId": trim(item.get("id")),
        "publishedAt": trim(item.get("gmtCreated")),
    }
    tasks: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    candidates = [{"displayName": trim(item.get("newFileName")), "url": trim(item.get("newFileUrl"))}]
    candidates.extend(item.get("productFileList") or [])
    for candidate in candidates:
        label = trim(candidate.get("displayName")) or trim(candidate.get("fileName"))
        material_type = bsl_product_info_material_type(label)
        material_url = bsl_product_info_material_url(trim(candidate.get("url")))
        if not material_type or not material_url or material_url in seen_urls:
            continue
        seen_urls.add(material_url)
        tasks.append(
            {
                "company": company,
                "productName": product_name,
                "productType": product["productType"],
                "salesStatus": product["salesStatus"],
                "label": label,
                "materialType": material_type,
                "url": material_url,
                "sourcePage": product["sourcePage"],
            }
        )
    return product, tasks


def bsl_product_info_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "保险责任正文为空"
    if re.match(r"^(?:保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外|其中)", text):
        return "valid_partial", "疑似从条款中段开始"
    if not has_actual_responsibility_text(text):
        return "suspect_needs_source_check", "缺少明确保险责任触发条件或给付规则"
    return "valid_complete", ""


def crawl_bsl_product_info_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    pdf_status, data = fetch_bytes_direct(material_url, referer=trim(task.get("sourcePage")) or BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text:
        return None
    quality_status, quality_issue = bsl_product_info_quality(page_text)
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "中银三星人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")),
        "salesStatus": trim(task.get("salesStatus")),
        "title": label or f"{product_name}产品资料",
        "url": material_url,
        "snippet": f"中银三星人寿官网{label or '产品资料'}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")),
        "official": True,
        "officialDomain": BOC_SAMSUNG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_boc_samsung_life_product_info_directory",
        "qualityStatus": quality_status,
        "qualityReason": quality_issue,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_boc_samsung_life_product_info_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中银三星人寿"
    page_size = max(1, int(payload.get("pageSize") or 20))
    start_page = max(1, int(payload.get("startPage") or 1))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    page_number = start_page
    fetched_pages = 0

    while True:
        status, data = bsl_product_info_fetch_page(page_number, page_size)
        rows = data.get("list") if isinstance(data.get("list"), list) else []
        page_meta = {
            "url": BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT,
            "status": status,
            "pageNumber": page_number,
            "pageSize": page_size,
            "totalCount": int(data.get("total") or 0),
            "totalPages": int(data.get("pages") or 0),
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if status < 200 or status >= 300:
            pages.append(page_meta)
            break
        for item in rows:
            product, product_tasks = bsl_product_info_tasks_from_item(company, item)
            if not product:
                continue
            product_key = f"{product.get('productCode')}|{product.get('productName')}|{product.get('publishedAt')}"
            if product_key not in seen_products:
                if max_products and len(seen_products) >= max_products:
                    continue
                seen_products.add(product_key)
                products.append(product)
                page_meta["productCount"] += 1
            for task in product_tasks:
                material_url = trim(task.get("url"))
                if not material_url or material_url in skip_urls or material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                tasks.append(task)
                page_meta["materialTaskCount"] += 1
        pages.append(page_meta)
        fetched_pages += 1
        if max_products and len(seen_products) >= max_products:
            break
        if max_pages and fetched_pages >= max_pages:
            break
        if not data.get("hasNextPage"):
            break
        page_number += 1

    if max_workers <= 1:
        records = [record for record in (crawl_bsl_product_info_material_record(task) for task in tasks) if record]
    else:
        records: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(crawl_bsl_product_info_material_record, task) for task in tasks]
            for future in as_completed(futures):
                record = future.result()
                if record:
                    records.append(record)
    for page in pages:
        if page["status"] >= 200 and page["status"] < 300:
            page["recordCount"] = len(records)
            break
    return {
        "ok": all(int(page.get("status") or 0) >= 200 and int(page.get("status") or 0) < 300 for page in pages),
        "company": company,
        "source": BOC_SAMSUNG_LIFE_OFFICIAL_BASE_URL,
        "endpoint": BOC_SAMSUNG_LIFE_PRODUCT_INFO_ENDPOINT,
        "startPage": start_page,
        "pageSize": page_size,
        "maxPages": max_pages,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
    }


def sinokorea_life_decode_html(raw_html: str, page_url: str) -> str:
    if not raw_html:
        return ""
    if "document.write" not in raw_html and "<body" in raw_html.lower():
        return raw_html
    node_code = r"""
const vm = require('vm');
const fs = require('fs');
const pageUrl = process.argv[1] || '';
const raw = fs.readFileSync(0, 'utf8');
const scripts = [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
let writes = [];
const sandbox = {
  location: { href: pageUrl, host: 'www.sinokorealife.com.cn', hostname: 'www.sinokorealife.com.cn' },
  navigator: { userAgent: 'Mozilla/5.0', webdriver: false },
  document: {
    cookie: '',
    write: (value) => writes.push(String(value)),
    writeln: (value) => writes.push(String(value) + '\n'),
    createElement: () => ({}),
    getElementsByTagName: () => [],
    addEventListener: () => {},
  },
  console: { log: () => {}, warn: () => {}, error: () => {} },
  setTimeout: () => {},
  clearTimeout: () => {},
  setInterval: () => {},
  clearInterval: () => {},
};
sandbox.window = sandbox;
for (const script of scripts) {
  vm.runInNewContext(script, sandbox, { timeout: 10000 });
}
process.stdout.write(writes.join('') || raw);
"""
    proc = subprocess.run(
        ["node", "-e", node_code, page_url],
        input=raw_html.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=20,
    )
    decoded = proc.stdout.decode("utf-8", "ignore")
    return decoded if proc.returncode == 0 and decoded.strip() else raw_html


def fetch_sinokorea_life_html(url: str) -> tuple[int, str]:
    status, raw_html = fetch_html_direct(url)
    if status < 200 or status >= 300:
        return status, raw_html
    return status, sinokorea_life_decode_html(raw_html, url)


def sinokorea_life_official_url(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    return host in SINOKOREA_LIFE_OFFICIAL_DOMAINS


def sinokorea_life_product_type(product_name: str, category: str = "") -> str:
    name = trim(product_name)
    if "团体" in name:
        return "团体保险"
    if "医疗" in name or "津贴" in name:
        return "医疗险"
    if "重大疾病" in name or "疾病" in name or "防癌" in name or "护理" in name:
        return "健康险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name or "教育金" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    return trim(category)


def sinokorea_life_product_name(title: str) -> str:
    name = trim(re.sub(r"条款$", "", trim(title)))
    return name or trim(title)


def sinokorea_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "保险责任正文为空"
    if re.match(r"^(?:保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外|其中)", text):
        return "valid_partial", "疑似从条款中段开始"
    if not has_actual_responsibility_text(text):
        return "suspect_needs_source_check", "缺少明确保险责任触发条件或给付规则"
    return "valid_complete", ""


def extract_sinokorea_life_product_tasks(
    company: str,
    html: str,
    max_products: int,
    skip_urls: set[str],
    sales_status_filter: set[str],
    start_index: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[dict[str, Any]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    seen_detail_urls: set[str] = set()
    sections = [
        ("/zscp.jhtml", "在售", "/zscp/"),
        ("/tscp.jhtml", "停售", "/tscp/"),
    ]
    for src, sales_status, path_marker in sections:
        section = soup.find(attrs={"data-src": src})
        rows = section.find_all("tr") if section else []
        page_meta = {
            "url": urljoin(SINOKOREA_LIFE_OFFICIAL_BASE_URL, src),
            "status": 200 if section else 0,
            "salesStatus": sales_status,
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        matched_index = 0
        for row in rows:
            if sales_status_filter and sales_status not in sales_status_filter:
                continue
            link = row.find("a", href=re.compile(rf"^{re.escape(path_marker)}\d+\.jhtml$"))
            if not link:
                continue
            if matched_index < start_index:
                matched_index += 1
                continue
            matched_index += 1
            title = trim(link.get("title")) or clean_text(link.get_text(" ", strip=True))
            detail_url = urljoin(SINOKOREA_LIFE_OFFICIAL_BASE_URL, trim(link.get("href")))
            if not title or detail_url in seen_detail_urls:
                continue
            if max_products and len(seen_products) >= max_products:
                continue
            cells = row.find_all("td")
            category = clean_text(cells[2].get_text(" ", strip=True)) if len(cells) > 2 else ""
            published_at = clean_text(cells[3].get_text(" ", strip=True)) if len(cells) > 3 else ""
            product_name = sinokorea_life_product_name(title)
            product_key = f"{sales_status}|{product_name}|{published_at}"
            seen_detail_urls.add(detail_url)
            if product_key not in seen_products:
                seen_products.add(product_key)
                page_meta["productCount"] += 1
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": sinokorea_life_product_type(product_name, category),
                        "salesStatus": sales_status,
                        "category": category,
                        "publishedAt": published_at,
                        "sourcePage": detail_url,
                    }
                )
            if detail_url not in skip_urls:
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": sinokorea_life_product_type(product_name, category),
                        "salesStatus": sales_status,
                        "category": category,
                        "publishedAt": published_at,
                        "label": title,
                        "materialType": "terms",
                        "detailUrl": detail_url,
                    }
                )
                page_meta["materialTaskCount"] += 1
        pages.append(page_meta)
    return products, tasks, pages


def sinokorea_life_detail_pdf_url(detail_url: str) -> tuple[int, str]:
    status, html = fetch_sinokorea_life_html(detail_url)
    if status < 200 or status >= 300:
        return status, ""
    soup = BeautifulSoup(html or "", "html.parser")
    for iframe in soup.find_all("iframe"):
        src = trim(iframe.get("src"))
        file_values = parse_qs(urlsplit(src).query).get("file") if src else []
        if file_values:
            pdf_url = urljoin(SINOKOREA_LIFE_OFFICIAL_BASE_URL, file_values[0])
            return status, pdf_url if sinokorea_life_official_url(pdf_url) else ""
    match = re.search(r"(/u/cms/www/[^\"']+\.pdf)", html or "", re.I)
    if match:
        pdf_url = urljoin(SINOKOREA_LIFE_OFFICIAL_BASE_URL, match.group(1))
        return status, pdf_url if sinokorea_life_official_url(pdf_url) else ""
    return status, ""


def crawl_sinokorea_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    detail_url = trim(task.get("detailUrl"))
    detail_status, material_url = sinokorea_life_detail_pdf_url(detail_url)
    if detail_status < 200 or detail_status >= 300 or not material_url:
        return None
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=detail_url, max_bytes=MAX_PDF_BYTES)
    if (
        pdf_status < 200
        or pdf_status >= 300
        or len(data) > MAX_PDF_BYTES
        or not data.startswith(b"%PDF")
        or ("pdf" not in content_type.lower() and content_type)
    ):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    quality_status, quality_issue = sinokorea_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label"))
    return {
        "company": trim(task.get("company")) or "中韩人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or sinokorea_life_product_type(product_name, trim(task.get("category"))),
        "salesStatus": trim(task.get("salesStatus")),
        "title": label or f"{product_name}条款",
        "url": material_url,
        "snippet": f"中韩人寿/东方嘉富人寿官网{label or '产品条款'}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or "terms",
        "official": True,
        "officialDomain": SINOKOREA_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_sinokorea_life_product_info",
        "qualityStatus": quality_status,
        "qualityReason": quality_issue,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "sourcePage": detail_url,
        "publishedAt": trim(task.get("publishedAt")),
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
    }


def crawl_sinokorea_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "中韩人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    start_index = max(0, int(payload.get("startIndex") or 0))
    sales_status_value = trim(payload.get("salesStatus")).lower()
    sales_status_filter = set()
    if sales_status_value in {"in_sale", "sale", "onsale", "在售"}:
        sales_status_filter = {"在售"}
    elif sales_status_value in {"stopped", "stop", "停售"}:
        sales_status_filter = {"停售"}
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    status, html = fetch_sinokorea_life_html(SINOKOREA_LIFE_PRODUCT_INFO_URL)
    if status < 200 or status >= 300:
        return {
            "ok": False,
            "company": company,
            "source": SINOKOREA_LIFE_OFFICIAL_BASE_URL,
            "endpoint": SINOKOREA_LIFE_PRODUCT_INFO_URL,
            "pages": [{"url": SINOKOREA_LIFE_PRODUCT_INFO_URL, "status": status, "productCount": 0, "materialTaskCount": 0, "recordCount": 0}],
            "products": [],
            "materialTaskCount": 0,
            "records": [],
        }
    products, tasks, pages = extract_sinokorea_life_product_tasks(company, html, max_products, skip_urls, sales_status_filter, start_index)
    if max_workers <= 1:
        records = [record for record in (crawl_sinokorea_life_material_record(task) for task in tasks) if record]
    else:
        records: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(crawl_sinokorea_life_material_record, task) for task in tasks]
            for future in as_completed(futures):
                record = future.result()
                if record:
                    records.append(record)
    record_counts_by_status: dict[str, int] = {}
    for record in records:
        status_label = trim(record.get("salesStatus"))
        record_counts_by_status[status_label] = record_counts_by_status.get(status_label, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_status.get(trim(page.get("salesStatus")), 0)
    return {
        "ok": True,
        "company": company,
        "source": SINOKOREA_LIFE_OFFICIAL_BASE_URL,
        "endpoint": SINOKOREA_LIFE_PRODUCT_INFO_URL,
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "startIndex": start_index,
        "salesStatus": sales_status_value or "all",
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
    }


def changsheng_life_sale_status_filter(value: str) -> set[str]:
    text = trim(value).lower()
    if text in {"", "all", "全部"}:
        return {"在售", "停售"}
    if text in {"in_sale", "sale", "onsale", "available", "在售"}:
        return {"在售"}
    if text in {"stopped", "stop", "off_sale", "discontinued", "停售"}:
        return {"停售"}
    output: set[str] = set()
    if "在售" in text:
        output.add("在售")
    if "停售" in text:
        output.add("停售")
    return output or {"在售", "停售"}


def changsheng_life_official_url(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in CHANGSHENG_LIFE_OFFICIAL_DOMAINS


def changsheng_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "团体" in name:
        return "团体保险"
    if "医疗" in name or "津贴" in name or "住院" in name:
        return "医疗险"
    if "重大疾病" in name or "疾病" in name or "防癌" in name or "护理" in name:
        return "健康险"
    if "意外" in name or "交通" in name:
        return "意外险"
    if "年金" in name or "养老" in name or "教育金" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "万能" in name:
        return "万能账户"
    if "投连" in name or "投资连结" in name:
        return "投连险"
    if "终身寿险" in name or "定期寿险" in name or name.endswith("寿险"):
        return "寿险"
    return "其他"


def changsheng_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "保险责任正文为空"
    if re.match(r"^(?:保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外|其中)", text):
        return "valid_partial", "疑似从条款中段开始"
    if not has_actual_responsibility_text(text):
        return "suspect_needs_source_check", "缺少明确保险责任触发条件或给付规则"
    return "valid_complete", ""


def changsheng_life_clean_page_text(page_text: str) -> str:
    text = re.sub(r"\x00", "", page_text or "")
    text = re.sub(r"(?:\s*h7g,?\s*){2,}", "\n", text)
    return clean_text(text)


def changsheng_life_product_tasks_from_html(
    company: str,
    page_url: str,
    html: str,
    sales_status: str,
    max_products: int,
    skip_urls: set[str],
    seen_products: set[str],
    seen_urls: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    soup = BeautifulSoup(html or "", "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    for table in soup.find_all("table"):
        headers: list[str] = []
        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"], recursive=False)
            texts = [clean_text(cell.get_text(" ", strip=True)) for cell in cells]
            if "产品名称" in texts and "条款" in texts:
                headers = texts
                continue
            if not headers or len(cells) < 2:
                continue
            product_name_index = headers.index("产品名称") if "产品名称" in headers else 0
            terms_index = headers.index("条款") if "条款" in headers else 1
            if product_name_index >= len(cells) or terms_index >= len(cells):
                continue
            product_name = clean_text(cells[product_name_index].get_text(" ", strip=True))
            if not product_name or product_name in {"个人保险产品", "团体保险产品", "互联网保险产品"}:
                continue
            terms_cell = cells[terms_index]
            anchors = terms_cell.find_all("a")
            if not anchors:
                continue
            product_key = f"{sales_status}|{product_name}"
            product = {
                "company": company,
                "productName": product_name,
                "productType": changsheng_life_product_type(product_name),
                "salesStatus": sales_status,
                "sourcePage": page_url,
            }
            if product_key not in seen_products:
                if max_products and len(seen_products) >= max_products:
                    continue
                seen_products.add(product_key)
                products.append(product)
            for anchor in anchors:
                label = clean_text(anchor.get_text(" ", strip=True)) or "条款"
                href = trim(anchor.get("href"))
                material_url = urljoin(CHANGSHENG_LIFE_OFFICIAL_BASE_URL, href)
                if not href or label != "条款" or not changsheng_life_official_url(material_url):
                    continue
                lower_url = material_url.lower()
                if not (lower_url.endswith(".pdf") or lower_url.endswith(".zip")):
                    continue
                if material_url in skip_urls or material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product["productType"],
                        "salesStatus": sales_status,
                        "label": label,
                        "materialType": "terms",
                        "url": material_url,
                        "sourcePage": page_url,
                    }
                )
    return products, tasks


def changsheng_life_select_pdf_from_zip(data: bytes) -> tuple[str, bytes]:
    if not data or len(data) > MAX_ZIP_BYTES or not data.startswith(b"PK"):
        return "", b""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), metadata_encoding="gbk")
    except TypeError:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return "", b""
    try:
        entries = [item for item in archive.infolist() if item.filename.lower().endswith(".pdf") and not item.is_dir()]
        if not entries:
            return "", b""
        preferred = [
            item
            for item in entries
            if "条款" in item.filename
            and not re.search(r"费率|现金|说明|分类|声明|告知|职业|利益演示|投保须知", item.filename)
        ]
        selected = preferred[0] if preferred else entries[0]
        return selected.filename, archive.read(selected)
    finally:
        archive.close()


def crawl_changsheng_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    referer = trim(task.get("sourcePage")) or CHANGSHENG_LIFE_PRODUCT_INFO_URL
    if not material_url or not changsheng_life_official_url(material_url):
        return None
    source_type = "zip" if material_url.lower().endswith(".zip") else "pdf"
    max_bytes = MAX_ZIP_BYTES if source_type == "zip" else MAX_PDF_BYTES
    status, content_type, data = fetch_binary_direct(material_url, referer=referer, max_bytes=max_bytes)
    if status < 200 or status >= 300 or len(data) > max_bytes:
        return None
    archive_entry = ""
    pdf_data = data
    if source_type == "zip":
        archive_entry, pdf_data = changsheng_life_select_pdf_from_zip(data)
        if not archive_entry:
            return None
    if not pdf_data.startswith(b"%PDF"):
        return None
    if source_type == "pdf" and content_type and "pdf" not in content_type.lower() and "octet-stream" not in content_type.lower():
        return None
    extracted = extract_pdf_text_with_system_python(pdf_data)
    page_text = changsheng_life_clean_page_text(focused_responsibility_excerpt(extracted.get("text", "")))
    quality_status, quality_issue = changsheng_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "条款"
    record_url = material_url if source_type == "pdf" else f"{material_url}#{archive_entry}"
    return {
        "company": trim(task.get("company")) or "长生人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or changsheng_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": record_url,
        "archiveUrl": material_url if source_type == "zip" else "",
        "archiveEntry": archive_entry,
        "snippet": f"长生人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": source_type,
        "materialType": trim(task.get("materialType")) or "terms",
        "official": True,
        "officialDomain": CHANGSHENG_LIFE_OFFICIAL_DOMAIN,
        "parser": "scrapling_changsheng_life_product_info",
        "qualityStatus": quality_status,
        "qualityReason": quality_issue,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "sourcePage": referer,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "pdfBytes": len(pdf_data),
    }


def crawl_changsheng_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_changsheng_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_changsheng_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_changsheng_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "长生人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    status_filter = changsheng_life_sale_status_filter(trim(payload.get("saleStatus") or payload.get("salesStatus") or payload.get("status")))
    skip_urls = {trim(item).split("#", 1)[0] for item in (payload.get("skipUrls") or []) if trim(item)}
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    for page_info in CHANGSHENG_LIFE_PRODUCT_PAGES:
        page_url = page_info["url"]
        sales_status = page_info["salesStatus"]
        page_meta = {
            "url": page_url,
            "status": 0,
            "salesStatus": sales_status,
            "productCount": 0,
            "materialTaskCount": 0,
            "recordCount": 0,
        }
        if sales_status not in status_filter:
            pages.append(page_meta)
            continue
        status, html = fetch_html_direct(page_url, referer=CHANGSHENG_LIFE_PRODUCT_INFO_URL)
        page_meta["status"] = status
        if status < 200 or status >= 300:
            pages.append(page_meta)
            continue
        page_products, page_tasks = changsheng_life_product_tasks_from_html(
            company,
            page_url,
            html,
            sales_status,
            max_products,
            skip_urls,
            seen_products,
            seen_urls,
        )
        products.extend(page_products)
        tasks.extend(page_tasks)
        page_meta["productCount"] = len(page_products)
        page_meta["materialTaskCount"] = len(page_tasks)
        pages.append(page_meta)
        if max_products and len(seen_products) >= max_products:
            break
    records = crawl_changsheng_life_material_records(tasks, max_workers=max_workers)
    record_counts_by_status: dict[str, int] = {}
    for record in records:
        sales_status = trim(record.get("salesStatus"))
        record_counts_by_status[sales_status] = record_counts_by_status.get(sales_status, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_status.get(trim(page.get("salesStatus")), 0)
    return {
        "ok": all(int(page.get("status") or 0) == 0 or 200 <= int(page.get("status") or 0) < 300 for page in pages),
        "company": company,
        "source": CHANGSHENG_LIFE_OFFICIAL_BASE_URL,
        "endpoint": CHANGSHENG_LIFE_PRODUCT_INFO_URL,
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
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
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
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
        **archive_pdf_bytes(data, pdf_archive_dir, material_url),
    }


def crawl_bohai_life_archive_material_records(task: dict[str, str]) -> list[dict[str, Any]]:
    archive_url = trim(task.get("url"))
    if not archive_url or not bohai_life_is_archive_url(archive_url):
        return []
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
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
        entry_url = bohai_life_archive_entry_url(archive_url, entry)
        extracted = extract_pdf_text_with_system_python(pdf_bytes)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        if not page_text or "保险责任" not in page_text:
            continue
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
                **archive_pdf_bytes(pdf_bytes, pdf_archive_dir, entry_url),
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
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
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
            task["pdfArchiveDir"] = pdf_archive_dir
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
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for record in records if trim(record.get("pdfLocalPath"))),
    }


def hengqin_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "医疗" in name or "住院" in name or "津贴" in name:
        return "医疗险"
    if "重大疾病" in name or "疾病" in name or "癌" in name:
        return "重疾险"
    if "意外" in name:
        return "意外险"
    if "护理" in name:
        return "护理险"
    if "年金" in name or "养老" in name or "教育金" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "终身寿险" in name:
        return "增额终身寿险"
    if "定期寿险" in name:
        return "定期寿险"
    if "万能" in name:
        return "万能账户"
    if "投连" in name or "投资连结" in name:
        return "投连险"
    return "其他"


def hengqin_life_material_type(label: str) -> str:
    text = trim(label)
    if "说明" in text:
        return "product_manual"
    if "条款" in text:
        return "terms"
    return ""


def hengqin_life_keep_material(label: str, material_url: str) -> bool:
    text = clean_text(f"{label} {material_url}")
    if ".pdf" not in material_url.lower():
        return False
    if "条款" not in text and "说明" not in text:
        return False
    return not EXCLUDED_MATERIAL_RE.search(text)


def hengqin_life_official_url(url: str) -> bool:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except Exception:
        return False
    return host in HENGQIN_LIFE_OFFICIAL_DOMAINS


def hengqin_life_fetch_json(path: str, params: dict[str, Any] | None = None, referer: str = HENGQIN_LIFE_PRODUCT_INFO_URL) -> tuple[int, dict[str, Any]]:
    query = dict(params or {})
    query["t"] = int(time.time())
    url = f"{HENGQIN_LIFE_API_BASE_URL}{path}?{urlencode(query)}"
    remote_client = base64.b64encode(json.dumps({"appId": 308, "visitorId": None}, ensure_ascii=False).encode("utf-8")).decode("ascii")
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
            f"Referer: {referer}",
            "-H",
            f"X-Remote-Client: {remote_client}",
            quote_url(url),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=40,
    )
    if proc.returncode != 0:
        return 0, {}
    try:
        return 200, json.loads(proc.stdout.decode("utf-8", "ignore"))
    except Exception:
        return 200, {}


def hengqin_life_article_content(article_code: str, referer: str) -> tuple[int, dict[str, Any]]:
    status, response = hengqin_life_fetch_json("/new/newsDetails", {"code": article_code}, referer=referer)
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    return status, data


def hengqin_life_cell_text(cell: Any) -> str:
    return html_text(str(cell)).replace("\xa0", " ").strip()


def hengqin_life_normalize_product_name(value: str) -> str:
    text = clean_text(value)
    text = re.sub(r"\s+", "", text)
    return text.strip("：:；;、")


def hengqin_life_parse_material_tasks(company: str, article: dict[str, Any], profile: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    content = trim(article.get("content"))
    soup = BeautifulSoup(content, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    current_product = ""
    current_date = ""
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    source_page = f"{HENGQIN_LIFE_PRODUCT_INFO_URL}/{profile['path']}"
    for row in soup.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if not cells:
            continue
        row_text = hengqin_life_cell_text(row)
        if "产品名称" in row_text and "产品报备材料" in row_text:
            continue
        first_text = hengqin_life_cell_text(cells[0]) if cells else ""
        second_text = hengqin_life_cell_text(cells[1]) if len(cells) > 1 else ""
        if len(cells) >= 3 and not cells[0].find("a"):
            candidate_product = hengqin_life_normalize_product_name(first_text)
            if candidate_product and "产品名称" not in candidate_product:
                current_product = candidate_product
                current_date = second_text
        elif len(cells) >= 2 and not cells[0].find("a") and re.search(r"\d{4}年\d{1,2}月\d{1,2}日", first_text):
            current_date = first_text
        if not current_product:
            continue
        product_key = f"{current_product}|{profile['salesStatus']}"
        if product_key not in seen_products:
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": current_product,
                    "productType": hengqin_life_product_type(current_product),
                    "salesStatus": profile["salesStatus"],
                    "sourcePage": source_page,
                    "publishedAt": current_date,
                    "sourceArticleCode": trim(article.get("code")),
                }
            )
        for anchor in row.find_all("a"):
            label = trim(anchor.get_text(" ", strip=True)) or trim(anchor.get("title")) or "产品资料"
            title = trim(anchor.get("title")) or label
            material_url = urljoin(HENGQIN_LIFE_OFFICIAL_BASE_URL, trim(anchor.get("href")))
            parts = urlsplit(material_url)
            if parts.scheme == "http" and (parts.hostname or "").lower() == "static.e-hqins.com":
                material_url = urlunsplit(("https", parts.netloc, parts.path, parts.query, parts.fragment))
            if not hengqin_life_official_url(material_url) or not hengqin_life_keep_material(f"{label} {title}", material_url):
                continue
            if material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            material_type_value = hengqin_life_material_type(f"{label} {title}")
            tasks.append(
                {
                    "company": company,
                    "productName": current_product,
                    "productType": hengqin_life_product_type(current_product),
                    "salesStatus": profile["salesStatus"],
                    "label": "产品说明书" if material_type_value == "product_manual" else "保险条款",
                    "materialType": material_type_value,
                    "title": title if title.endswith(".pdf") else f"{current_product}{label}",
                    "url": material_url,
                    "sourcePage": source_page,
                    "publishedAt": current_date,
                    "sourceArticleCode": trim(article.get("code")),
                    "sourceArticleTitle": trim(article.get("title")) or profile["label"],
                }
            )
    return products, tasks


def hengqin_life_responsibility_excerpt(text: str) -> str:
    normalized = normalize_responsibility_source_text(text)
    if not normalized:
        return ""
    best = ""
    for match in re.finditer(r"保险责任", normalized):
        start = match.start()
        if is_responsibility_toc_context(normalized, start):
            continue
        tail = normalized[start:]
        end_match = re.search(r"(?:\d+(?:[．.]\d+)+|第[一二三四五六七八九十百]+条|❸|三[、.])\s*(?:责任免除|其他免责条款|如何申请领取保险金|如何申请|受益人|保险金申请)", tail[80:])
        excerpt = tail[: 80 + end_match.start()] if end_match else tail[:MAX_EXCERPT_CHARS]
        excerpt = excerpt[:MAX_EXCERPT_CHARS].strip()
        if has_actual_responsibility_text(excerpt) and len(excerpt) > len(best):
            best = excerpt
    return best or focused_responsibility_excerpt(text)


def hengqin_life_quality(page_text: str) -> tuple[str, str]:
    text = clean_text(page_text)
    if not text:
        return "invalid_empty", "blank_or_placeholder"
    if re.match(r"^(保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外|其中)", text):
        return "valid_partial", "starts_mid_clause"
    if not has_actual_responsibility_text(text):
        return "suspect_needs_source_check", "no_clear_trigger_or_payment"
    return "valid_complete", ""


def crawl_hengqin_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not hengqin_life_official_url(material_url):
        return None
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=trim(task.get("sourcePage")) or HENGQIN_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = hengqin_life_responsibility_excerpt(extracted.get("text", ""))
    quality_status, quality_issue = hengqin_life_quality(page_text)
    if quality_status in {"invalid_empty", "invalid_non_responsibility"}:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "保险条款"
    host = (urlsplit(material_url).hostname or "").lower()
    return {
        "company": trim(task.get("company")) or "横琴人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or hengqin_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": trim(task.get("title")) or f"{product_name}{label}",
        "url": material_url,
        "snippet": f"横琴人寿官网{trim(task.get('sourceArticleTitle')) or '产品信息'}{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or hengqin_life_material_type(label),
        "official": True,
        "officialDomain": host,
        "parser": "scrapling_hengqin_life_product_info",
        "qualityStatus": quality_status,
        "qualityReason": quality_issue,
        "responsibilityQualityStatus": quality_status,
        "responsibilityQualityIssue": quality_issue,
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
        "sourcePage": trim(task.get("sourcePage")),
        "publishedAt": trim(task.get("publishedAt")),
        "sourceArticleCode": trim(task.get("sourceArticleCode")),
    }


def crawl_hengqin_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_hengqin_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_hengqin_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def hengqin_life_status_filter(value: str) -> set[str]:
    normalized = trim(value).lower()
    if normalized in {"", "all", "全部"}:
        return {"in_sale", "stopped"}
    selected: set[str] = set()
    for part in re.split(r"[,，\s]+", normalized):
        if part in {"in_sale", "sale", "active", "在售", "y", "1"}:
            selected.add("in_sale")
        elif part in {"stopped", "stop", "停售", "n", "0"}:
            selected.add("stopped")
    return selected or {"in_sale", "stopped"}


def crawl_hengqin_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "横琴人寿"
    status_filter = hengqin_life_status_filter(trim(payload.get("saleStatus") or payload.get("status")))
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("productOffset") or payload.get("offset") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    skip_urls = {trim(item) for item in (payload.get("skipUrls") or []) if trim(item)}
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    for key, profile in HENGQIN_LIFE_PRODUCT_ARTICLES.items():
        if key not in status_filter:
            continue
        referer = f"{HENGQIN_LIFE_PRODUCT_INFO_URL}/{profile['path']}"
        status, article = hengqin_life_article_content(profile["code"], referer=referer)
        page_products, page_tasks = hengqin_life_parse_material_tasks(company, article, profile) if article else ([], [])
        pages.append(
            {
                "url": referer,
                "status": status,
                "articleCode": profile["code"],
                "label": profile["label"],
                "salesStatus": profile["salesStatus"],
                "productCount": len(page_products),
                "materialTaskCount": len(page_tasks),
                "recordCount": 0,
            }
        )
        for product in page_products:
            product_key = f"{trim(product.get('productName'))}|{trim(product.get('salesStatus'))}"
            if product_key in seen_products:
                continue
            seen_products.add(product_key)
            products.append(product)
        for task in page_tasks:
            material_url = trim(task.get("url"))
            if not material_url or material_url in skip_urls or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)

    selected_products = products[product_offset:]
    if max_products:
        selected_products = selected_products[:max_products]
        allowed = {trim(product.get("productName")) for product in selected_products}
        tasks = [task for task in tasks if trim(task.get("productName")) in allowed]

    records = crawl_hengqin_life_material_records(tasks, max_workers=max_workers)
    product_by_name = {trim(product.get("productName")): product for product in selected_products}
    selected_records = [record for record in records if trim(record.get("productName")) in product_by_name]
    record_counts_by_page: dict[str, int] = {}
    for record in selected_records:
        source_page = trim(record.get("sourcePage"))
        record_counts_by_page[source_page] = record_counts_by_page.get(source_page, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)
    return {
        "ok": all(int(page.get("status") or 0) >= 200 and int(page.get("status") or 0) < 300 for page in pages),
        "company": company,
        "source": HENGQIN_LIFE_PRODUCT_INFO_URL,
        "officialDomain": HENGQIN_LIFE_OFFICIAL_DOMAIN,
        "officialDomains": sorted(HENGQIN_LIFE_OFFICIAL_DOMAINS),
        "saleStatus": sorted(status_filter),
        "maxProducts": max_products,
        "productOffset": product_offset,
        "maxWorkers": max_workers,
        "pages": pages,
        "totalCandidateProductCount": len(products),
        "products": selected_products,
        "materialTaskCount": len(tasks),
        "records": sorted(selected_records, key=lambda record: trim(record.get("url"))),
    }


def soochow_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "医疗" in name:
        return "医疗险"
    if "护理" in name or "重大疾病" in name or "疾病" in name or "恶性肿瘤" in name:
        return "重疾险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "增额终身寿险" in name:
        return "增额终身寿险"
    if "万能" in name:
        return "万能账户"
    if "定期寿险" in name:
        return "定期寿险"
    return "其他"


def soochow_life_material_type(label: str) -> str:
    return "product_manual" if "说明" in trim(label) else "terms"


def soochow_life_keep_material(label: str, material_url: str) -> bool:
    text = clean_text(f"{label} {material_url}")
    if not material_url.lower().split("?", 1)[0].endswith(".pdf"):
        return False
    if "条款" not in text and "说明" not in text:
        return False
    return not EXCLUDED_MATERIAL_RE.search(text)


def soochow_life_page_url(page_number: int) -> str:
    if page_number <= 1:
        return SOOCHOW_LIFE_PRODUCT_INFO_URL
    return f"{SOOCHOW_LIFE_PRODUCT_INFO_URL}&currentPage={page_number}"


def soochow_life_normalize_url(href: str, page_url: str) -> str:
    raw = trim(href)
    if not raw:
        return ""
    candidate = urljoin(page_url, raw)
    hostname = (urlsplit(candidate).hostname or "").lower()
    if hostname not in SOOCHOW_LIFE_OFFICIAL_DOMAINS:
        return ""
    return candidate


def soochow_life_sales_status(row: Any, fallback: str) -> str:
    text = clean_text(row.get_text(" ", strip=True) if row else "")
    if "停售" in text or "已停售" in text:
        return "停售"
    return fallback


def extract_soochow_life_page(company: str, page_number: int, fallback_status: str, max_products: int) -> dict[str, Any]:
    page_url = soochow_life_page_url(page_number)
    status, html = fetch_html_direct(page_url, referer=SOOCHOW_LIFE_PRODUCT_INFO_URL)
    page_meta = {
        "url": page_url,
        "status": status,
        "pageNumber": page_number,
        "productCount": 0,
        "materialTaskCount": 0,
        "recordCount": 0,
    }
    if status < 200 or status >= 300 or not html:
        return {"page": page_meta, "products": [], "tasks": []}
    soup = BeautifulSoup(html, "html.parser")
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    for row in soup.find_all("tr"):
        product_cell = row.find(attrs={"data-title": "产品名称"})
        material_cell = row.find(attrs={"data-title": re.compile(r"产品材料|点击查看")})
        if not product_cell or not material_cell:
            continue
        product_name = html_text(str(product_cell)).replace("\ufeff", "")
        if not product_name or product_name in {"产品名称", "保险产品名称"}:
            continue
        product_name = product_name.replace("（已停售）", "").replace("(已停售）", "").replace("（已停售)", "").strip()
        product_type = soochow_life_product_type(product_name)
        sales_status = soochow_life_sales_status(row, fallback_status)
        product_key = f"{product_name}|{sales_status}"
        if product_key not in seen_products:
            if max_products and len(products) >= max_products:
                break
            seen_products.add(product_key)
            products.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "sourcePage": page_url,
                }
            )
        for anchor in material_cell.find_all("a"):
            label = html_text(str(anchor)) or trim(anchor.get("title")) or "产品材料"
            material_url = soochow_life_normalize_url(trim(anchor.get("href")), page_url)
            if not soochow_life_keep_material(label, material_url) or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(
                {
                    "company": company,
                    "productName": product_name,
                    "productType": product_type,
                    "salesStatus": sales_status,
                    "label": label,
                    "materialType": soochow_life_material_type(label),
                    "url": material_url,
                    "sourcePage": page_url,
                }
            )
    page_meta["productCount"] = len(products)
    page_meta["materialTaskCount"] = len(tasks)
    return {"page": page_meta, "products": products, "tasks": tasks}


def crawl_soochow_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    hostname = (urlsplit(material_url).hostname or "").lower()
    if hostname not in SOOCHOW_LIFE_OFFICIAL_DOMAINS:
        return None
    pdf_status, content_type, data = fetch_binary_direct(material_url, referer=trim(task.get("sourcePage")) or SOOCHOW_LIFE_PRODUCT_INFO_URL)
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "保险条款"
    return {
        "company": trim(task.get("company")) or "东吴人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or soochow_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": f"{product_name}{label}",
        "url": material_url,
        "snippet": f"东吴人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or soochow_life_material_type(label),
        "official": True,
        "officialDomain": hostname,
        "parser": "scrapling_soochow_life_product_info",
        "qualityStatus": "valid_complete",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
    }


def crawl_soochow_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (crawl_soochow_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(crawl_soochow_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_soochow_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "东吴人寿"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("productOffset") or 0))
    max_pages = max(1, int(payload.get("maxPages") or 1))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 6))
    pages: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()

    for page_number in range(1, max_pages + 1):
        remaining = max(0, product_offset + max_products - len(products)) if max_products else 0
        page_result = extract_soochow_life_page(company, page_number, "在售", remaining)
        page_products = page_result["products"]
        page_tasks = page_result["tasks"]
        if not page_products and page_number > 1:
            break
        selected_page_products = page_products[product_offset:]
        if max_products:
            selected_page_products = selected_page_products[:max_products]
        allowed_names = {trim(product.get("productName")) for product in selected_page_products}
        for product in selected_page_products:
            product_key = f"{trim(product.get('productName'))}|{trim(product.get('salesStatus'))}"
            if product_key in seen_products:
                continue
            seen_products.add(product_key)
            products.append(product)
        task_count = 0
        for task in page_tasks:
            if max_products and trim(task.get("productName")) not in allowed_names:
                continue
            material_url = trim(task.get("url"))
            if not material_url or material_url in seen_urls:
                continue
            seen_urls.add(material_url)
            tasks.append(task)
            task_count += 1
        page_meta = page_result["page"]
        page_meta["materialTaskCount"] = task_count
        pages.append(page_meta)
        if max_products and len(products) >= max_products:
            break

    records = crawl_soochow_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)

    return {
        "ok": True,
        "company": company,
        "source": SOOCHOW_LIFE_PRODUCT_INFO_URL,
        "officialDomain": SOOCHOW_LIFE_OFFICIAL_DOMAIN,
        "maxProducts": max_products,
        "productOffset": product_offset,
        "maxPages": max_pages,
        "maxWorkers": max_workers,
        "pages": pages,
        "products": products,
        "materialTaskCount": len(tasks),
        "records": records,
    }


def guolian_life_product_type(product_name: str) -> str:
    name = trim(product_name)
    if "医疗" in name:
        return "医疗险"
    if "重大疾病" in name or "疾病" in name or "恶性肿瘤" in name or "护理" in name:
        return "重疾险"
    if "意外" in name:
        return "意外险"
    if "年金" in name or "养老" in name:
        return "年金险"
    if "两全" in name:
        return "两全保险"
    if "增额终身寿险" in name:
        return "增额终身寿险"
    if "万能" in name:
        return "万能账户"
    if "定期寿险" in name:
        return "定期寿险"
    return "其他"


def guolian_life_material_type(label: str) -> str:
    return "product_manual" if "说明" in trim(label) else "terms"


def guolian_life_official_url(url: str) -> bool:
    try:
        hostname = (urlsplit(url).hostname or "").lower()
    except Exception:
        return False
    return hostname in GUOLIAN_LIFE_OFFICIAL_DOMAINS


def guolian_life_keep_material(label: str, material_url: str) -> bool:
    text = clean_text(f"{label} {material_url}")
    if not material_url.lower().split("?", 1)[0].endswith(".pdf"):
        return False
    if "条款" not in text and "说明" not in text:
        return False
    return not EXCLUDED_MATERIAL_RE.search(text)


def guolian_life_source_scopes(value: str) -> list[dict[str, str]]:
    normalized = trim(value).lower()
    if normalized in {"", "all", "全部"}:
        return [GUOLIAN_LIFE_PRODUCT_MENUS["in_sale"], GUOLIAN_LIFE_PRODUCT_MENUS["stopped"]]
    if normalized in {"in_sale", "sale", "available", "在售", "y", "1"}:
        return [GUOLIAN_LIFE_PRODUCT_MENUS["in_sale"]]
    if normalized in {"stopped", "stop", "discontinued", "停售", "n", "0"}:
        return [GUOLIAN_LIFE_PRODUCT_MENUS["stopped"]]
    return [GUOLIAN_LIFE_PRODUCT_MENUS["in_sale"], GUOLIAN_LIFE_PRODUCT_MENUS["stopped"]]


async def guolian_life_fetch_catalog_pages_async(scopes: list[dict[str, str]], max_pages: int) -> list[dict[str, Any]]:
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:
        raise RuntimeError(f"GUOLIAN_LIFE_PLAYWRIGHT_UNAVAILABLE: {exc}") from exc

    pages: list[dict[str, Any]] = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page()
        try:
            for scope in scopes:
                menu_code = trim(scope.get("menuCode"))
                grade = trim(scope.get("grade")) or "4"
                route_url = f"{GUOLIAN_LIFE_PRODUCT_PAGE_URL}?menuCode={quote(menu_code)}&grade={quote(grade)}"
                await page.goto(route_url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(1200)
                first = await page.evaluate(
                    """async ({menuCode, grade}) => {
                      const mod = await import('/web/assets/index-DIHm7fd8.js');
                      return await mod.ag({menuCode, grade, pageNo: 1});
                    }""",
                    {"menuCode": menu_code, "grade": grade},
                )
                total_pages = int(first.get("totalPage") or 1)
                limit = min(total_pages, max_pages) if max_pages else total_pages
                first["sourceScope"] = scope
                first["pageNo"] = 1
                pages.append(first)
                for page_no in range(2, limit + 1):
                    data = await page.evaluate(
                        """async ({menuCode, grade, pageNo}) => {
                          const mod = await import('/web/assets/index-DIHm7fd8.js');
                          return await mod.ag({menuCode, grade, pageNo});
                        }""",
                        {"menuCode": menu_code, "grade": grade, "pageNo": page_no},
                    )
                    data["sourceScope"] = scope
                    data["pageNo"] = page_no
                    pages.append(data)
        finally:
            await browser.close()
    return pages


def guolian_life_fetch_catalog_pages(scopes: list[dict[str, str]], max_pages: int) -> list[dict[str, Any]]:
    return asyncio.run(guolian_life_fetch_catalog_pages_async(scopes, max_pages=max_pages))


def guolian_life_products_and_tasks(
    company: str,
    catalog_pages: list[dict[str, Any]],
    max_products: int,
    product_offset: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[dict[str, Any]]]:
    products: list[dict[str, Any]] = []
    tasks: list[dict[str, str]] = []
    pages: list[dict[str, Any]] = []
    seen_products: set[str] = set()
    seen_urls: set[str] = set()
    product_index = 0

    for catalog_page in catalog_pages:
        scope = catalog_page.get("sourceScope") or {}
        sales_status = trim(scope.get("salesStatus"))
        source_page = (
            f"{GUOLIAN_LIFE_PRODUCT_PAGE_URL}?menuCode={quote(trim(scope.get('menuCode')))}&grade={quote(trim(scope.get('grade')) or '4')}"
        )
        page_product_count = 0
        page_task_count = 0
        for item in catalog_page.get("articleInfoList") or []:
            product_name = trim(item.get("title"))
            if not product_name:
                continue
            page_product_count += 1
            product_index += 1
            if product_index <= product_offset:
                continue
            if max_products and len(products) >= max_products:
                continue
            product_type = guolian_life_product_type(product_name)
            product_key = f"{product_name}|{sales_status}"
            if product_key not in seen_products:
                seen_products.add(product_key)
                products.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": sales_status,
                        "sourcePage": source_page,
                    }
                )
            for material in item.get("articleInfoFileList") or []:
                label = trim(material.get("articleName"))
                material_url = trim(material.get("fileurl") or material.get("fileUrl"))
                if not guolian_life_official_url(material_url) or not guolian_life_keep_material(label, material_url):
                    continue
                if material_url in seen_urls:
                    continue
                seen_urls.add(material_url)
                tasks.append(
                    {
                        "company": company,
                        "productName": product_name,
                        "productType": product_type,
                        "salesStatus": sales_status,
                        "label": label,
                        "materialType": guolian_life_material_type(label),
                        "title": label,
                        "url": material_url,
                        "sourcePage": source_page,
                        "articleId": trim(item.get("articleId")),
                    }
                )
                page_task_count += 1
        pages.append(
            {
                "url": source_page,
                "pageNumber": int(catalog_page.get("pageNo") or 1),
                "totalPage": int(catalog_page.get("totalPage") or 1),
                "title": trim(catalog_page.get("articleInfoTitle")) or trim(scope.get("label")),
                "salesStatus": sales_status,
                "productCount": page_product_count,
                "materialTaskCount": page_task_count,
                "recordCount": 0,
            }
        )
    return products, tasks, pages


def guolian_life_material_record(task: dict[str, str]) -> dict[str, Any] | None:
    material_url = trim(task.get("url"))
    if not guolian_life_official_url(material_url):
        return None
    pdf_status, content_type, data = fetch_binary_direct(
        material_url,
        referer=trim(task.get("sourcePage")) or GUOLIAN_LIFE_OFFICIAL_BASE_URL,
    )
    if pdf_status < 200 or pdf_status >= 300 or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF"):
        return None
    extracted = extract_pdf_text_with_system_python(data)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    if not page_text or "保险责任" not in page_text:
        return None
    product_name = trim(task.get("productName"))
    label = trim(task.get("label")) or "保险条款"
    hostname = (urlsplit(material_url).hostname or "").lower()
    return {
        "company": trim(task.get("company")) or "国联人寿",
        "productName": product_name,
        "productType": trim(task.get("productType")) or guolian_life_product_type(product_name),
        "salesStatus": trim(task.get("salesStatus")),
        "title": trim(task.get("title")) or f"{product_name}{label}",
        "url": material_url,
        "snippet": f"国联人寿官网{label}，已截取保险责任正文段。",
        "pageText": page_text,
        "sourceType": "pdf",
        "materialType": trim(task.get("materialType")) or guolian_life_material_type(label),
        "official": True,
        "officialDomain": hostname,
        "parser": "scrapling_guolian_life_product_info",
        "qualityStatus": "valid_complete",
        "responsibilityQualityStatus": "valid_complete",
        "responsibilityQualityIssue": "",
        "pages": extracted.get("pages", 0),
        "bytes": len(data),
        "contentType": content_type,
    }


def guolian_life_material_records(tasks: list[dict[str, str]], max_workers: int) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if max_workers <= 1:
        return [record for record in (guolian_life_material_record(task) for task in tasks) if record]
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(guolian_life_material_record, task) for task in tasks]
        for future in as_completed(futures):
            record = future.result()
            if record:
                records.append(record)
    return records


def crawl_guolian_life_pages(payload: dict[str, Any]) -> dict[str, Any]:
    company = trim(payload.get("company")) or "国联人寿"
    sale_status = trim(payload.get("saleStatus")) or "all"
    max_products = max(0, int(payload.get("maxProducts") or 0))
    product_offset = max(0, int(payload.get("productOffset") or payload.get("offset") or 0))
    max_pages = max(0, int(payload.get("maxPages") or 0))
    max_workers = max(1, int(payload.get("maxWorkers") or payload.get("concurrency") or 4))
    scopes = guolian_life_source_scopes(sale_status)
    catalog_pages = guolian_life_fetch_catalog_pages(scopes, max_pages=max_pages)
    products, tasks, pages = guolian_life_products_and_tasks(company, catalog_pages, max_products, product_offset)
    records = guolian_life_material_records(tasks, max_workers=max_workers)
    task_page_by_url = {trim(task.get("url")): trim(task.get("sourcePage")) for task in tasks}
    record_counts_by_page: dict[str, int] = {}
    for record in records:
        page_url = task_page_by_url.get(trim(record.get("url")))
        if page_url:
            record_counts_by_page[page_url] = record_counts_by_page.get(page_url, 0) + 1
    for page in pages:
        page["recordCount"] = record_counts_by_page.get(trim(page.get("url")), 0)
    return {
        "ok": True,
        "company": company,
        "source": "guolian_life_official_product_info",
        "officialDomain": "guolian-life.com",
        "officialDomains": sorted(GUOLIAN_LIFE_OFFICIAL_DOMAINS),
        "pages": pages,
        "totalCandidateProductCount": sum(int(page.get("productCount") or 0) for page in pages),
        "products": products,
        "materialTaskCount": len(tasks),
        "records": sorted(records, key=lambda record: trim(record.get("url"))),
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
    pdf_archive_dir = trim(task.get("pdfArchiveDir"))
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

    archive = archive_pdf_bytes(data, pdf_archive_dir, material_url) if pdf_archive_dir else {}
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
            **archive,
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
            **archive,
        },
    }


def reextract_responsibility_records(payload: dict[str, Any]) -> dict[str, Any]:
    tasks = payload.get("records") if isinstance(payload.get("records"), list) else payload.get("tasks")
    if not isinstance(tasks, list):
        tasks = []
    max_workers = max(1, min(8, int(payload.get("maxWorkers") or payload.get("concurrency") or 3)))
    pdf_archive_dir = resolve_pdf_archive_dir(payload)
    tasks = [{**task, "pdfArchiveDir": pdf_archive_dir} if isinstance(task, dict) else task for task in tasks]
    records: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    if not tasks:
        return {
            "ok": True,
            "taskCount": 0,
            "recordCount": 0,
            "skippedCount": 0,
            "records": [],
            "skipped": [],
            "pdfArchiveDir": pdf_archive_dir,
            "archivedPdfCount": 0,
        }
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
        "pdfArchiveDir": pdf_archive_dir,
        "archivedPdfCount": sum(1 for item in [*records, *skipped] if trim(item.get("pdfLocalPath"))),
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
    if trim(payload.get("mode")) == "ping_an_loan_rate_products":
        return crawl_ping_an_loan_rate_products(payload)
    if trim(payload.get("mode")) == "ping_an_historical_seed":
        return crawl_ping_an_historical_seed(payload)
    if trim(payload.get("mode")) == "jrcpcx_insurance_catalog_ui":
        return crawl_jrcpcx_insurance_catalog_ui(payload)
    if trim(payload.get("mode")) == "jrcpcx_insurance_catalog":
        return crawl_jrcpcx_insurance_catalog(payload)
    if trim(payload.get("mode")) == "taikang_life_pages":
        return crawl_taikang_life_pages(payload)
    if trim(payload.get("mode")) == "sunshine_life_browser_pages":
        return crawl_sunshine_life_browser_pages(payload)
    if trim(payload.get("mode")) == "zhongan_pages":
        return crawl_zhongan_pages(payload)
    if trim(payload.get("mode")) == "hongkang_life_pages":
        return crawl_hongkang_life_pages(payload)
    if trim(payload.get("mode")) == "guohua_life_pages":
        return crawl_guohua_life_pages(payload)
    if trim(payload.get("mode")) == "happy_life_pages":
        return crawl_happy_life_pages(payload)
    if trim(payload.get("mode")) == "xiaokang_life_pages":
        return crawl_xiaokang_life_pages(payload)
    if trim(payload.get("mode")) == "caixin_life_pages":
        return crawl_caixin_life_pages(payload)
    if trim(payload.get("mode")) == "focused_responsibility_excerpt":
        return {"ok": True, "pageText": focused_responsibility_excerpt(trim(payload.get("text")))}
    if trim(payload.get("mode")) == "guobao_life_material_tasks":
        return crawl_guobao_life_material_tasks(payload)
    if trim(payload.get("mode")) == "guobao_life_pages":
        return crawl_guobao_life_pages(payload)
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
    if trim(payload.get("mode")) == "haibao_life_pages":
        return crawl_haibao_life_pages(payload)
    if trim(payload.get("mode")) == "hsbc_life_pages":
        return crawl_hsbc_life_pages(payload)
    if trim(payload.get("mode")) == "huagui_life_pages":
        return crawl_huagui_life_pages(payload)
    if trim(payload.get("mode")) == "huahui_life_pages":
        return crawl_huahui_life_pages(payload)
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
    if trim(payload.get("mode")) == "boc_samsung_life_product_info_pages":
        return crawl_boc_samsung_life_product_info_pages(payload)
    if trim(payload.get("mode")) == "boc_samsung_life_pages":
        return crawl_boc_samsung_life_pages(payload)
    if trim(payload.get("mode")) == "sinokorea_life_pages":
        return crawl_sinokorea_life_pages(payload)
    if trim(payload.get("mode")) == "changsheng_life_pages":
        return crawl_changsheng_life_pages(payload)
    if trim(payload.get("mode")) == "xintai_life_product_info":
        return crawl_xintai_life_product_info(payload)
    if trim(payload.get("mode")) == "xintai_life_internet_products":
        return crawl_xintai_life_internet_products(payload)
    if trim(payload.get("mode")) == "metlife_china_life_pages":
        return crawl_metlife_china_life_pages(payload)
    if trim(payload.get("mode")) == "abc_life_pages":
        return crawl_abc_life_pages(payload)
    if trim(payload.get("mode")) == "yingda_life_pages":
        return crawl_yingda_life_pages(payload)
    if trim(payload.get("mode")) == "icbc_axa_life_pages":
        return crawl_icbc_axa_life_pages(payload)
    if trim(payload.get("mode")) == "aviva_cofco_life_pages":
        return crawl_aviva_cofco_life_pages(payload)
    if trim(payload.get("mode")) == "greatwall_life_pages":
        return crawl_greatwall_life_pages(payload)
    if trim(payload.get("mode")) == "guofu_life_pages":
        return crawl_guofu_life_pages(payload)
    if trim(payload.get("mode")) == "beijing_life_pages":
        return crawl_beijing_life_pages(payload)
    if trim(payload.get("mode")) == "ruitai_life_pages":
        return crawl_ruitai_life_pages(payload)
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
    if trim(payload.get("mode")) == "fosun_prudential_life_pages":
        return crawl_fosun_prudential_life_pages(payload)
    if trim(payload.get("mode")) == "citic_prudential_life_pages":
        return crawl_citic_prudential_life_pages(payload)
    if trim(payload.get("mode")) == "fosun_uhi_health_pages":
        return crawl_fosun_uhi_health_pages(payload)
    if trim(payload.get("mode")) == "bob_cardif_life_pages":
        return crawl_bob_cardif_life_pages(payload)
    if trim(payload.get("mode")) == "generali_china_life_pages":
        return crawl_generali_china_life_pages(payload)
    if trim(payload.get("mode")) == "dingcheng_life_pages":
        return crawl_dingcheng_life_pages(payload)
    if trim(payload.get("mode")) == "pku_founder_life_pages":
        return crawl_pku_founder_life_pages(payload)
    if trim(payload.get("mode")) == "bohai_life_pages":
        return crawl_bohai_life_pages(payload)
    if trim(payload.get("mode")) == "hengqin_life_pages":
        return crawl_hengqin_life_pages(payload)
    if trim(payload.get("mode")) == "soochow_life_pages":
        return crawl_soochow_life_pages(payload)
    if trim(payload.get("mode")) == "guolian_life_pages":
        return crawl_guolian_life_pages(payload)
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
