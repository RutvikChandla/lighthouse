/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';


const Audit = require('./audit.js');
const i18n = require('./../lib/i18n/i18n.js');
const ComputedUserTimings = require('../computed/user-timings.js');

const UIStrings = {
  /** Title of a Lighthouse audit that provides a potential cause of CLS. This descriptive title is shown to users when no iframe is injected in a time window before a LayoutShift event. */
  title: 'Injected Iframes likely didn\'t contribute to CLS',
  /** Title of a Lighthouse audit that provides a potential cause of CLS. This descriptive title is shown to users when an iframe is injected in a time window before a LayoutShift event. */
  failureTitle: 'Injected Iframes potentially contributed to CLS',
  /** Description of a Lighthouse audit that tells the user potential causes of CLS. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description: 'Injecting an Iframe with a correctly sized container can reduce layout shifting and improve CLS. [Learn More](https://web.dev/optimize-cls/#ads-embeds-and-iframes-without-dimensions)',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

/**
 * @param {LH.Artifacts.TraceOfTab['layoutShiftTimelineEvents']} layoutEvents
 * @return {Array<LH.Artifacts.DOMWindow>}
 */
function getLayoutShiftWindows(layoutEvents) {
  /**@type {Array<LH.Artifacts.DOMWindow>} */
  const windows = [];
  // filter layout events to SSR, ULTs, layoutshifts 
  // then just look at timing

  // TODO: use a map for this ?
  for (let i = 0; i < layoutEvents.length; i++) {
    const event = layoutEvents[i].event;
    const SSRStart = layoutEvents[i].timing;
    const SSREnd = SSRStart + layoutEvents[i].duration;
    // layout shift hapens under ULT
    // all timeline, reverse
    // look for 
    // look for a ScheduleStyleRecalculation
    if (event.name === 'ScheduleStyleRecalculation') {
      // look for a ULT within this limit, assume that a ULT belongs to a SSR if occurs within 20ms
      const limit = SSRStart +  20;
      // look for ULT
      for (let j = i+1; j < layoutEvents.length; j++) {
        const ULTStart = layoutEvents[j].timing;
        const ULTEnd = ULTStart + layoutEvents[j].duration;
        if (layoutEvents[j].event.name === 'UpdateLayerTree' && ULTStart >= SSRStart && ULTStart < limit) {
          // Look for ULT's layout shift if any
          for(let k = j+1; k < layoutEvents.length; k++) {
            // if there is a layout shift within an update layer tree, it causes CLS - keep track
            if (layoutEvents[k].event.name === 'LayoutShift') {
              //console.log("FOUND A LAYOUTSHIFT");
              const layoutShiftStart = layoutEvents[k].timing;
              const layoutShiftEnd = layoutShiftStart + layoutEvents[k].duration;
              // layout shift doesn't have a duration - NaN
              // shift is within ULT
              if (layoutShiftStart >= ULTStart && layoutShiftStart <= ULTEnd) {
                // If the iframe injection is somewhere between this - yes
                windows.push({start: SSRStart, end: ULTEnd});
              }
            }
          }
        }
      }
    }
  }
  return windows;
}

class PreloadFontsAudit extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'injected-iframes',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      requiredArtifacts: ['DOMTimeline', 'traces'],
    };
  }

  

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const {timestamps, layoutEvents, originEvt} = artifacts.DOMTimeline;
    const windows = getLayoutShiftWindows(layoutEvents);
    //console.log("timestamps: ", timestamps, " ", timestamps.length);
    console.log("window stamps: ", windows, " ", windows.length);
    console.log("number of iframe timestamps: ", timestamps.length);
    console.log("number of CLS windows: ", windows.length);
    //console.log("iframes: ", timestamps);
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    let iframeResults = new Map();
    // console.log(" trace: ", trace);
    let timingNormalization = 0;
    // TODO: await this?
    /** might not need this */
    ComputedUserTimings.request(trace, context).then(computedUserTimings => {
      const userTimings = computedUserTimings.filter(timing => timing.name === 'lh_timealign');
      console.log("getting user timings?? ", userTimings.length);
      // can we assume that timing in client will always be <= timing on trace ?
      // are assuming that first item in userTimings / smallest will be the one we want
      // Based on Tab start
      console.log("start of observer: ", userTimings[0].startTime);
      // Based on system start
      console.log("origin evt time: ", originEvt);
      timingNormalization = (userTimings[0].startTime - timestamps[0].time);
      //console.log("user timings: ", userTimings[0].startTime, ", timestamps: ", timestamps[0].time);
      //console.log("end user timings: ", userTimings[userTimings.length -1].startTime, ", end timestamps: ", timestamps[timestamps.length-1].time);
      //console.log("how many userTimings? ", userTimings.length, " how many timestamps: ", timestamps.length);
    });
    
    const results = [];
    for (const timestamp of timestamps) {
      //const time = timestamp.time + timingNormalization;
      //console.log("is node type element node? ", typeof timestamp.element);
      const time = timestamp.time;
      for (const window of windows) {
        // if iframe timestamp is within a CLS window timeframe, it is considered to contribute to CLS
        if (time > window.start && time < window.end) {
          // Make sure an iframe is only added once to results
          const ad = "id=\"aswift_";
          if (!iframeResults.has(timestamp.devtoolsNodePath) && timestamp.snippet.includes(ad)){
            iframeResults.set(timestamp.devtoolsNodePath, timestamp.snippet);
            //console.log("time in range, with normalization: ", time);
            results.push({
              node: /** @type {LH.Audit.Details.NodeValue} */ ({
                type: 'node',
                path: timestamp.devtoolsNodePath,
                selector: timestamp.selector,
                nodeLabel: timestamp.nodeLabel,
                snippet: timestamp.snippet,
              }),
            });
          }
        }
      }
    }
    //console.log("RESULTS: ", results);
    console.log("num of RESULTS: ", results.length);
    //console.log("RESULTS: ", results);

    /** @type {LH.Audit.Details.Table['headings']} */
    const headings = [
      {key: 'node', itemType: 'node', text: str_(i18n.UIStrings.columnElement)},
    ];

    return {
      score: results.length > 0 ? 0 : 1,
      details: Audit.makeTableDetails(headings, results),
      notApplicable: timestamps.length === 0,
    };
  }
}

module.exports = PreloadFontsAudit;
module.exports.UIStrings = UIStrings;
