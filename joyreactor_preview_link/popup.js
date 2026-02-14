/* global chrome */

const api = typeof browser !== "undefined" ? browser : chrome;

document.getElementById("title").textContent = api.i18n.getMessage("extName");
document.getElementById("desc").textContent = api.i18n.getMessage("extDescription");

