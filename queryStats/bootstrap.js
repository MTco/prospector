/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
const global = this;
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/DownloadUtils.jsm");
Cu.import("resource://gre/modules/PlacesUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

/**
 * Analyze form history with web history and output results
 */
function analyze(doc, maxCount, maxRepeat, maxDepth, maxBreadth) {
  // XXX Force a QI until bug 609139 is fixed
  let {DBConnection} = PlacesUtils.history.QueryInterface(Ci.nsPIPlacesDatabase);

  // Show a page visit with an icon and linkify
  function addEntry(container, url, text, extra) {
    let div = container.appendChild(doc.createElement("div"));
    let a = div.appendChild(doc.createElement("a"));
    a.href = url;
    let img = a.appendChild(doc.createElement("img"));
    img.style.height = "16px";
    img.style.paddingRight = "4px";
    img.style.width = "16px";
    img.src = PlacesUtils.favicons.getFaviconImageForPage(Utils.makeURI(url)).spec;
    a.appendChild(doc.createTextNode(text));
    div.appendChild(doc.createTextNode(extra || ""));
    return div;
  }

  // Recursively follow link clicks to some depth
  function addLinks(container, visitId, depth, numObj) {
    if (depth > maxDepth)
      return;

    // Initialze a number object pass by reference
    if (numObj == null)
      numObj = {val: 0};

    // Find pages from the current visit
    spinQuery(DBConnection, {
      names: ["url", "title", "nextVisit"],
      params: {
        breadth: maxBreadth,
        visitId: visitId,
      },
      query: "SELECT *, v.id as nextVisit " +
             "FROM moz_historyvisits v " +
             "JOIN moz_places h ON h.id = v.place_id " +
             "WHERE v.from_visit = :visitId " +
             "LIMIT :breadth",
    }).forEach(function({url, title, nextVisit}) {
      // Follow the redirect to find a page with a title
      if (title == null) {
        addLinks(container, nextVisit, depth, numObj);
        return;
      }

      let count = "";
      if (++numObj.val > 1)
        count = " (click " + numObj.val+ ")";

      // Add the result that we found then add its links
      let resultDiv = addEntry(container, url, title, count);
      resultDiv.style.marginLeft = "2em";
      addLinks(resultDiv, nextVisit, depth + 1);
    });
  }

  let results = doc.getElementById("results");
  results.innerHTML = "";

  // Get the last most recently used form history items
  spinQuery(Svc.Form.DBConnection, {
    names: ["value", "fieldname"],
    params: {
      count: maxCount,
    },
    query: "SELECT * " +
           "FROM moz_formhistory " +
           "ORDER BY lastUsed DESC " +
           "LIMIT :count",
  }).forEach(function({value, fieldname}) {
    let queries = 0;
    let queryField = fieldname == "searchbar-history" ? "" : fieldname.slice(-7);
    let queryVal = value.replace(/ /g, "+");

    // Find the pages that used those form history queries
    spinQuery(DBConnection, {
      names: ["url", "title", "startVisit", "visit_date"],
      params: {
        query: "%" + queryField + "=" + queryVal + "%",
        repeat: maxRepeat,
      },
      query: "SELECT *, v.id as startVisit " +
             "FROM moz_places h " +
             "JOIN moz_historyvisits v ON v.place_id = h.id " +
             "WHERE url LIKE :query AND visit_type = 1 " +
             "ORDER BY visit_date DESC " +
             "LIMIT :repeat",
    }).forEach(function({url, title, startVisit, visit_date}) {
      let host = Utils.makeURI(url).host.replace(/www\./, "");
      let timeDiff = Date.now() - visit_date / 1000;
      let ago = DownloadUtils.convertTimeUnits(timeDiff / 1000).join(" ");

      let count = "";
      if (++queries > 1)
        count = "(repeat " + queries + ")";

      // Add an entry for this search query and its related clicks
      let searchDiv = addEntry(results, url, value, [" @", host, ago, "ago", count].join(" "));
      addLinks(searchDiv, startVisit, 1);
    });
  });
}

/**
 * Handle the add-on being activated on install/enable
 */
function startup(data, reason) AddonManager.getAddonByID(data.id, function(addon) {
  // Load various javascript includes for helper functions
  ["utils"].forEach(function(fileName) {
    let fileURI = addon.getResourceURI("scripts/" + fileName + ".js");
    Services.scriptloader.loadSubScript(fileURI.spec, global);
  });

  Cu.import("resource://services-sync/util.js");
  let gBrowser = Services.wm.getMostRecentWindow("navigator:browser").gBrowser;

  // In the edge case where gBrowser is null just disable
  if (!gBrowser)
    return addon.userDisabled = true;

  // Open a tab with chrome privileges to replace the content
  let tab = gBrowser.selectedTab = gBrowser.addTab("chrome://browser/content/aboutHome.xhtml");
  tab.linkedBrowser.addEventListener("load", function() {
    tab.linkedBrowser.removeEventListener("load", arguments.callee, true);
    // overwrite onLoad function in chrome://browser/content/aboutHome.js
    tab.linkedBrowser.contentWindow.onLoad = function(){};

    let doc = tab.linkedBrowser.contentDocument;
    doc.body.innerHTML = '<style>span { display: inline-block; width: 7em; } input:not(#go) { width: 2em; }</style>' +
      '<a href="https://mozillalabs.com/prospector/2010/11/19/analyze-your-search-behavior/">Check Mozilla Labs "Analyze Your Search Behavior" for more information</a><br/>' +
      '<em>(This add-on deactivates itself after running once; use the <a href="about:addons">Add-ons Manager</a> to reactivate.)</em><br/>' +
      '<form id="form">' +
      '<span>Query Count:</span><input id="count" value="20"/> Number of search queries to look through<br/>' +
      '<span>Query Repeat:</span><input id="repeat" value="5"/> Number of repeat searches of each search query<br/>' +
      '<span>Link Depth:</span><input id="depth" value="4"/> Follow link clicks through how many pages?<br/>' +
      '<span>Link Breadth:</span><input id="breadth" value="10"/> Follow how many clicks from the same page?<br/>' +
      '<input id="go" type="submit" value="Analyze Search Queries!"/>' +
      '</form>' +
      '<div id="results"></div>';

    function $(id) parseInt(doc.getElementById(id).value) || 0;
    let go = doc.getElementById("go");

    // Fetch the form fields and visibly disable the form when analyzing
    function doAnalyze() {
      go.disabled = true;
      analyze(doc, $("count"), $("repeat"), $("depth"), $("breadth"));
      go.disabled = false;
    }

    // Analyze on enter/click and immediately
    doc.getElementById("form").addEventListener("submit", function(event) {
      event.preventDefault();
      doAnalyze();
    }, false);
    doAnalyze();
  }, true);

  // Disable after running
  addon.userDisabled = true;
});

function shutdown() {}
function install() {}
function uninstall() {}
