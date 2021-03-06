/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ActionTrust} from '../../../src/action-constants';
import {Animation} from '../../../src/animation';
import {CSS} from '../../../build/amp-pan-zoom-0.1.css';
import {
  DoubletapRecognizer,
  PinchRecognizer,
  SwipeXYRecognizer,
  TapRecognizer,
} from '../../../src/gesture-recognizers';
import {Gestures} from '../../../src/gesture';
import {Layout} from '../../../src/layout';
import {Services} from '../../../src/services';
import {bezierCurve} from '../../../src/curve';
import {clamp} from '../../../src/utils/math';
import {continueMotion} from '../../../src/motion';
import {createCustomEvent} from '../../../src/event-helper';
import {dev, user} from '../../../src/log';
import {
  layoutRectFromDomRect,
  layoutRectLtwh,
} from '../../../src/layout-rect';
import {numeric} from '../../../src/transition';

import {dict} from '../../../src/utils/object';
import {px, scale, setStyles, translate} from '../../../src/style';

const PAN_ZOOM_CURVE_ = bezierCurve(0.4, 0, 0.2, 1.4);
const TAG = 'amp-pan-zoom';
const DEFAULT_MAX_SCALE = 3;
const MAX_ANIMATION_DURATION = 250;


const ELIGIBLE_TAGS = {
  'svg': true,
  'DIV': true,
  'AMP-IMG': true,
  'AMP-LAYOUT': true,
};

const SUPPORT_VALIDATION_MSG = `${TAG} should
  have its target element as the one and only child`;

/**
 * @extends {AMP.BaseElement}
 */
export class AmpPanZoom extends AMP.BaseElement {
  // TODO (#15685): refactor this to share code with amp-image-viewer

  /** @param {!AmpElement} element */
  constructor(element) {

    super(element);

    /** @private {?Element} */
    this.content_ = null;

    /** @private {?../../../src/service/action-impl.ActionService} */
    this.action_ = null;

    /** @private {number} */
    this.sourceWidth_ = 0;

    /** @private {number} */
    this.sourceHeight_ = 0;

    /** @private {?../../../src/layout-rect.LayoutRectDef} */
    this.elementBox_ = null;

    /** @private {?../../../src/layout-rect.LayoutRectDef} */
    this.contentBox_ = null;

    /** @private {?UnlistenDef} */
    this.unlistenOnSwipePan_ = null;

    /** @private */
    this.scale_ = 1;

    /** @private */
    this.startScale_ = 1;

    /** @private */
    this.minScale_ = 1;

    /** @private */
    this.maxScale_ = DEFAULT_MAX_SCALE;

    /** @private */
    this.initialX_ = 0;

    /** @private */
    this.initialY_ = 0;

    /** @private */
    this.initialScale_ = 1;

    /** @private */
    this.startX_ = 0;

    /** @private */
    this.startY_ = 0;

    /** @private */
    this.posX_ = 0;

    /** @private */
    this.posY_ = 0;

    /** @private */
    this.minX_ = 0;

    /** @private */
    this.minY_ = 0;

    /** @private */
    this.maxX_ = 0;

    /** @private */
    this.maxY_ = 0;

    /** @private */
    this.xOffsetFromCenter_ = 0;

    /** @private */
    this.yOffsetFromCenter_ = 0;

    /** @private {?../../../src/gesture.Gestures} */
    this.gestures_ = null;

    /** @private {?../../../src/motion.Motion} */
    this.motion_ = null;

    /** @private */
    this.resetOnResize_ = false;

    /** @private {?Element} */
    this.zoomButton_ = null;

    /** @private */
    this.disableDoubleTap_ = false;
  }

  /** @override */
  buildCallback() {
    this.action_ = Services.actionServiceForDoc(this.element);
    const children = this.getRealChildren();

    user().assert(children.length == 1, SUPPORT_VALIDATION_MSG);
    user().assert(
        this.elementIsSupported_(children[0]),
        children[0].tagName + ` is not supported by ${TAG}`
    );
    this.element.classList.add('i-amphtml-pan-zoom');
    this.content_ = children[0];
    this.content_.classList.add('i-amphtml-pan-zoom-child');
    this.maxScale_ = this.getNumberAttributeOr_('max-scale', DEFAULT_MAX_SCALE);
    this.initialScale_ = this.getNumberAttributeOr_('initial-scale', 1);
    this.initialX_ = this.getNumberAttributeOr_('initial-x', 0);
    this.initialY_ = this.getNumberAttributeOr_('initial-y', 0);
    this.resetOnResize_ = this.element.hasAttribute('reset-on-resize');
    this.disableDoubleTap_ = this.element.hasAttribute('disable-double-tap');
    this.registerAction('transform', invocation => {
      const {args} = invocation;
      if (!args) {
        return;
      }
      const scale = args['scale'] || 1;
      const x = args['x'] || 0;
      const y = args['y'] || 0;
      return this.transform(x, y, scale);
    });
  }

  /**
   *
   * @param {number} x
   * @param {number} y
   * @param {number} scale
   */
  transform(x, y, scale) {
    this.updatePanZoomBounds_(scale);
    const boundX = this.boundX_(x, /*allowExtent*/ false);
    const boundY = this.boundY_(y, /*allowExtent*/ false);
    return this.set_(scale, boundX, boundY, /*animate*/ true)
        .then(() => this.onZoomRelease_());
  }

  /** @override */
  onMeasureChanged() {
    if (this.resetOnResize_) {
      this.resetContentDimensions_();
    }
  }

  /** @override */
  layoutCallback() {
    this.createZoomButton_();
    return this.resetContentDimensions_().then(this.setupGestures_());
  }

  /** @override */
  pauseCallback() {
    this.cleanupGestures_();
  }

  /** @override */
  resumeCallback() {
    if (this.content_) {
      this.scheduleLayout(this.content_);
    }
    this.setupGestures_();
  }

  /** @override */
  unlayoutCallback() {
    this.cleanupGestures_();
    return true;
  }

  /** @override */
  isLayoutSupported(layout) {
    return layout == Layout.FIXED ||
      layout == Layout.FIXED_HEIGHT ||
      layout == Layout.FILL ||
      layout == Layout.RESPONSIVE;
  }

  /**
   * Checks to see if an element is supported.
   * @param {Element} element
   * @return {boolean}
   * @private
   */
  elementIsSupported_(element) {
    return ELIGIBLE_TAGS[element.tagName];
  }

  /**
   * Creates zoom buttoms
   */
  createZoomButton_() {
    this.zoomButton_ = this.element.ownerDocument.createElement('div');
    this.zoomButton_.classList.add('amp-pan-zoom-in-icon');
    this.zoomButton_.classList.add('amp-pan-zoom-button');
    this.zoomButton_.addEventListener('click', () => {
      if (this.zoomButton_.classList.contains('amp-pan-zoom-in-icon')) {
        this.transform(0, 0, this.maxScale_);
        this.toggleZoomButtonOut_();
      } else {
        this.transform(0, 0, this.minScale_);
        this.toggleZoomButtonIn_();
      }
    });
    this.element.appendChild(this.zoomButton_);
  }

  /**
   * Tries to retrieve a number attribute, returns a default value
   * if unsuccessful.
   * @param {string} attribute
   * @param {number} defaultValue
   * @return {number}
   * @private
   */
  getNumberAttributeOr_(attribute, defaultValue) {
    const {element} = this;
    return element.hasAttribute(attribute)
      ? parseInt(element.getAttribute(attribute), 10)
      : defaultValue;
  }

  /**
   * @return {number}
   * @private
   */
  getYOffsetFromCenter_() {
    const elementContentGap = this.elementBox_.height - this.contentBox_.height;
    const distanceToCenter = elementContentGap / 2;
    return this.contentBox_.top - distanceToCenter;
  }

  /**
   * @return {number}
   * @private
   */
  getXOffsetFromCenter_() {
    const elementContentGap = this.elementBox_.width - this.contentBox_.width;
    const distanceToCenter = elementContentGap / 2;
    return this.contentBox_.left - distanceToCenter;
  }

  /**
   * Measures the content viewer and content sizes and positioning.
   * This must be called AFTER the source element has already been
   * laid out.
   * @private
   */
  measure_() {
    this.sourceWidth_ = this.content_./*OK*/scrollWidth;
    this.sourceHeight_ = this.content_./*OK*/scrollHeight;

    this.elementBox_ = layoutRectFromDomRect(this.element
        ./*OK*/getBoundingClientRect());

    const sourceAspectRatio = this.sourceWidth_ / this.sourceHeight_;
    const heightToFit = this.elementBox_.width / sourceAspectRatio;
    const widthToFit = this.elementBox_.height * sourceAspectRatio;
    let height = Math.min(heightToFit, this.elementBox_.height);
    let width = Math.min(widthToFit, this.elementBox_.width);

    if (Math.abs(width - this.sourceWidth_) <= 16
    && Math.abs(height - this.sourceHeight_ <= 16)) {
      width = this.sourceWidth_;
      height = this.sourceHeight_;
    }

    const contentBox =
      layoutRectFromDomRect(this.content_./*OK*/getBoundingClientRect());

    this.contentBox_ = layoutRectLtwh(
        contentBox.left - this.elementBox_.left,
        contentBox.top - this.elementBox_.top,
        Math.round(width),
        Math.round(height));

    this.yOffsetFromCenter_ = this.getYOffsetFromCenter_();
    this.xOffsetFromCenter_ = this.getXOffsetFromCenter_();

    // Adjust max scale to at least fit the screen.
    const elementBoxRatio = this.elementBox_.width /
     this.elementBox_.height;
    const maxScale = Math.max(
        elementBoxRatio / sourceAspectRatio,
        sourceAspectRatio / elementBoxRatio
    );
    this.maxScale_ = Math.max(this.maxScale_, maxScale);

    // Reset zoom and pan.
    this.startScale_ = this.scale_ = this.initialScale_;
    this.startX_ = this.posX_ = this.initialX_;
    this.startY_ = this.posY_ = this.initialY_;
    this.updatePanZoomBounds_(this.scale_);
  }

  /**
   * Measures and resets the content dimensions, after the element
   * dimensions changes.
   * @return {!Promise}
   */
  resetContentDimensions_() {
    const content = dev().assertElement(this.content_);
    return this.measureMutateElement(() => this.measure_(), () => {
      // Set the actual dimensions of the content
      setStyles(content, {
        width: px(this.contentBox_.width),
        height: px(this.contentBox_.height),
      });
      // Update translation and scaling
      this.updatePanZoom_();
    }, content);
  }

  /** @private */
  cleanupGestures_() {
    if (this.gestures_) {
      this.gestures_.cleanup();
      this.gestures_ = null;
    }
  }

  /**
   * Given a x offset relative to the viewport, return the x offset
   * relative to the amp-pan-zoom component.
   * @param {number} clientX
   */
  getOffsetX_(clientX) {
    const {left} = this.elementBox_;
    return (left - this.getViewport().getScrollLeft()) - clientX;
  }

  /**
   * Given a y offset relative to the viewport, return the y offset
   * relative to the amp-pan-zoom component.
   * @param {number} clientY
   */
  getOffsetY_(clientY) {
    const {top} = this.elementBox_;
    return (top - this.getViewport().getScrollTop()) - clientY;
  }

  /** @private */
  setupGestures_() {
    if (this.gestures_) {
      return;
    }
    // TODO (#12881): this and the subsequent use of event.preventDefault
    // is a temporary solution to #12362. We should revisit this problem after
    // resolving #12881 or change the use of window.event to the specific event
    // triggering the gesture.
    this.gestures_ = Gestures.get(
        this.element,
        /* opt_shouldNotPreventDefault */ false
    );

    this.gestures_.onPointerDown(() => {
      if (this.motion_) {
        this.motion_.halt();
      }
    });

    this.gestures_.onGesture(PinchRecognizer, e => {
      const {
        centerClientX,
        centerClientY,
        deltaX,
        deltaY,
        dir,
        last,
      } = e.data;

      this.onPinchZoom_(centerClientX, centerClientY, deltaX, deltaY, dir);
      if (last) {
        this.onZoomRelease_();
      }
    });

    // Override all taps to enable tap events on content
    this.gestures_.onGesture(TapRecognizer, e => {
      const event = createCustomEvent(this.win, 'click', null, {bubbles: true});
      e.data.target.dispatchEvent(event);
    });

    if (!this.disableDoubleTap_) {
      this.gestures_.onGesture(DoubletapRecognizer, e => {
        const {clientX, clientY} = e.data;
        const newScale = this.scale_ == 1 ? this.maxScale_ : this.minScale_;
        const dx = (this.elementBox_.width / 2) + this.getOffsetX_(clientX);
        const dy = (this.elementBox_.height / 2) + this.getOffsetY_(clientY);
        this.onZoom_(newScale, dx, dy, /*animate*/ true)
            .then(() => this.onZoomRelease_());
      });
    }

  }

  /**
   * Registers a Swipe gesture to handle panning when the content is zoomed.
   * @private
   */
  registerPanningGesture_() {
    // Movable.
    this.unlistenOnSwipePan_ = this.gestures_
        .onGesture(SwipeXYRecognizer, e => {
          event.preventDefault();
          const {
            deltaX,
            deltaY,
            last,
            velocityX,
            velocityY,
          } = e.data;
          this.onMove_(deltaX, deltaY, /*animate*/ false);
          if (last) {
            this.onMoveRelease_(velocityX, velocityY);
          }
        });
  }

  /**
   * Deregisters the Swipe gesture for panning when the content is zoomed out.
   * @private
   */
  unregisterPanningGesture_() {
    if (this.unlistenOnSwipePan_) {
      this.unlistenOnSwipePan_();
      this.unlistenOnSwipePan_ = null;
      this.gestures_.removeGesture(SwipeXYRecognizer);
    }
  }

  /**
   * Returns value bound to min and max values +/- extent.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @param {number} extent
   * @return {number}
   * @private
   */
  boundValue_(value, min, max, extent) {
    return clamp(value, min - extent, max + extent);
  }

  /**
   * Returns the scale within the allowed range with possible extent.
   * @param {number} s
   * @param {boolean} allowExtent
   * @return {number}
   * @private
   */
  boundScale_(s, allowExtent) {
    const extent = allowExtent ? 0.25 : 0;
    return this.boundValue_(s, this.minScale_, this.maxScale_, extent);
  }

  /**
   * Returns the X position within the allowed range with possible extent.
   * @param {number} x
   * @param {boolean} allowExtent
   * @return {number}
   * @private
   */
  boundX_(x, allowExtent) {
    const maxExtent = this.elementBox_.width * 0.25;
    const extent = allowExtent && this.scale_ > 1 ? maxExtent : 0;
    return this.boundValue_(x, this.minX_, this.maxX_, extent);
  }

  /**
   * Returns the Y position within the allowed range with possible extent.
   * @param {number} y
   * @param {boolean} allowExtent
   * @return {number}
   * @private
   */
  boundY_(y, allowExtent) {
    const maxExtent = this.elementBox_.height * 0.25;
    const extent = allowExtent && this.scale_ > 1 ? maxExtent : 0;
    return this.boundValue_(y, this.minY_, this.maxY_, extent);
  }

  /**
   * Updates X/Y bounds based on the provided scale value. The min/max bounds
   * are calculated to allow full pan of the content regardless of the scale
   * value.
   * @param {number} scale
   * @private
   */
  updatePanZoomBounds_(scale) {
    const dh = this.elementBox_.height - (this.contentBox_.height * scale);
    const dw = this.elementBox_.width - (this.contentBox_.width * scale);

    const minY = dh >= 0 ? 0 : dh / 2;
    const maxY = dh >= 0 ? 0 : -minY;
    const minX = dw >= 0 ? 0 : dw / 2;
    const maxX = dw >= 0 ? 0 : -minX;

    const xOffset = scale == 1 ? 0 : this.xOffsetFromCenter_;
    const yOffset = scale == 1 ? 0 : this.yOffsetFromCenter_;

    this.minX_ = minX - xOffset;
    this.minY_ = minY - yOffset;
    this.maxX_ = maxX - xOffset;
    this.maxY_ = maxY - yOffset;

  }

  /**
   * Updates pan/zoom of the content based on the current values.
   * @private
   */
  updatePanZoom_() {
    const {scale_: s, posX_: x, posY_: y, content_: content} = this;
    this.mutateElement(() => {
      setStyles(dev().assertElement(content), {
        transform: translate(x, y) + ' ' + scale(s),
      });
    }, content);
  }

  /**
   * @param {number} scale
   * @param {number} x
   * @param {number} y
   * @private
   */
  triggerTransformEnd_(scale, x, y) {
    const transformEndEvent =
    createCustomEvent(this.win, `${TAG}.transformEnd`, dict({
      'scale': scale,
      'x': x,
      'y': y,
    }));
    this.action_.trigger(this.element, 'transformEnd', transformEndEvent,
        ActionTrust.HIGH);
  }

  /**
   * Performs a one-step or an animated motion (panning).
   * @param {number} deltaX
   * @param {number} deltaY
   * @param {boolean} animate
   * @private
   */
  onMove_(deltaX, deltaY, animate) {
    const newPosX = this.boundX_(this.startX_ + deltaX, false);
    const newPosY = this.boundY_(this.startY_ + deltaY, false);
    this.set_(this.scale_, newPosX, newPosY, animate);
  }

  /**
   * Performs actions once the motion gesture has been complete. The motion
   * may continue based on the final velocity.
   * @param {number} veloX
   * @param {number} veloY
   * @private
   */
  onMoveRelease_(veloX, veloY) {
    // Continue motion.
    this.motion_ = continueMotion(dev().assertElement(this.content_),
        this.posX_, this.posY_, veloX, veloY,
        (x, y) => {
          const newPosX = this.boundX_(x, false);
          const newPosY = this.boundY_(y, false);
          if (Math.abs(newPosX - this.posX_) < 1 &&
                Math.abs(newPosY - this.posY_) < 1) {
            // Hit the wall: stop motion.
            return false;
          }
          this.set_(this.scale_, newPosX, newPosY, false);
          return true;
        });

    // Snap back.
    this.motion_.thenAlways(() => {
      this.motion_ = null;
      return this.release_();
    });
  }

  /**
   * Performs a one-step pinch zoom action.
   * @param {number} centerClientX
   * @param {number} centerClientY
   * @param {number} deltaX
   * @param {number} deltaY
   *  @param {number} dir
   * @private
   */
  onPinchZoom_(centerClientX, centerClientY, deltaX, deltaY, dir) {
    this.zoomToPoint_(centerClientX, centerClientY, deltaX, deltaY, dir);
  }

  /**
   * Given center position, zoom delta, and zoom position, computes
   * and updates a zoom action on the content.
   * @param {number} centerClientX
   * @param {number} centerClientY
   * @param {number} deltaX
   * @param {number} deltaY
   * @param {number} dir
   * @private
   */
  zoomToPoint_(centerClientX, centerClientY, deltaX, deltaY, dir) {
    if (dir == 0) {
      return;
    }
    const dist = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
    const newScale = this.startScale_ * (1 + (dir * dist / 100));
    const deltaCenterX = (this.elementBox_.width / 2) - centerClientX;
    const deltaCenterY = (this.elementBox_.height / 2) - centerClientY;
    deltaX = Math.min(deltaCenterX, deltaCenterX * (dist / 100));
    deltaY = Math.min(deltaCenterY, deltaCenterY * (dist / 100));
    this.onZoom_(newScale, deltaX, deltaY, /*animate*/ false);
  }

  /**
   * Performs a one-step or an animated zoom action.
   * @param {number} scale
   * @param {number} deltaX
   * @param {number} deltaY
   * @param {boolean} animate
   * @return {!Promise}
   * @private
   */
  onZoom_(scale, deltaX, deltaY, animate) {
    const newScale = this.boundScale_(scale, true);
    if (newScale == this.scale_) {
      return Promise.resolve();
    }

    this.updatePanZoomBounds_(newScale);

    const newPosX = this.boundX_(this.startX_ + (deltaX * newScale), false);
    const newPosY = this.boundY_(this.startY_ + (deltaY * newScale), false);
    return this.set_(newScale, newPosX, newPosY, animate);
  }

  /**
   * @private
   */
  toggleZoomButtonIn_() {
    if (this.zoomButton_) {
      this.zoomButton_.classList.add('amp-pan-zoom-in-icon');
      this.zoomButton_.classList.remove('amp-pan-zoom-out-icon');
    }
  }

  /**
   * @private
   */
  toggleZoomButtonOut_() {
    if (this.zoomButton_) {
      this.zoomButton_.classList.remove('amp-pan-zoom-in-icon');
      this.zoomButton_.classList.add('amp-pan-zoom-out-icon');
    }
  }

  /**
   * Performs actions after the gesture that was performing zooming has been
   * released.
   * @return {!Promise}
   * @private
   */
  onZoomRelease_() {
    return this.release_().then(() => {
      // After the scale is updated, also register or unregister panning
      if (this.scale_ <= 1) {
        this.unregisterPanningGesture_();
        this.toggleZoomButtonIn_();
      } else {
        this.registerPanningGesture_();
        this.toggleZoomButtonOut_();
      }
    });
  }

  /**
   * Sets or animates pan/zoom parameters.
   * @param {number} newScale
   * @param {number} newPosX
   * @param {number} newPosY
   * @param {boolean} animate
   * @return {!Promise}
   * @private
   */
  set_(newScale, newPosX, newPosY, animate) {
    const ds = newScale - this.scale_;
    const dx = newPosX - this.posX_;
    const dy = newPosY - this.posY_;
    const dist = Math.sqrt((dx * dx) + (dy * dy));

    const dur = animate ?
      Math.min(1, Math.max(
          dist * 0.01, // Distance
          Math.abs(ds) // Change in scale
      )) * MAX_ANIMATION_DURATION : 0;

    if (dur > 16 && animate) {
      const scaleFunc = numeric(this.scale_, newScale);
      const xFunc = numeric(this.posX_, newPosX);
      const yFunc = numeric(this.posY_, newPosY);
      return Animation.animate(dev().assertElement(this.content_), time => {
        this.scale_ = scaleFunc(time);
        this.posX_ = xFunc(time);
        this.posY_ = yFunc(time);
        this.updatePanZoom_();
      }, dur, PAN_ZOOM_CURVE_).thenAlways(() => {
        this.scale_ = newScale;
        this.posX_ = newPosX;
        this.posY_ = newPosY;
        this.updatePanZoom_();
        this.triggerTransformEnd_(newScale, newPosX, newPosY);
      });
    } else {
      this.scale_ = newScale;
      this.posX_ = newPosX;
      this.posY_ = newPosY;
      this.updatePanZoom_();
      return Promise.resolve();
    }
  }

  /**
   * Sets or animates pan/zoom parameters after release of the gesture.
   * @return {!Promise}
   * @private
   */
  release_() {
    const newScale = this.boundScale_(this.scale_, false);
    if (newScale != this.scale_) {
      this.updatePanZoomBounds_(newScale);
    }
    const newPosX = this.boundX_(this.posX_ / this.scale_ * newScale, false);
    const newPosY = this.boundY_(this.posY_ / this.scale_ * newScale, false);
    return this.set_(newScale, newPosX, newPosY, true).then(() => {
      this.startScale_ = this.scale_;
      this.startX_ = this.posX_;
      this.startY_ = this.posY_;
      this.triggerTransformEnd_(this.scale_, this.posX_, this.posY_);
    });
  }
}

AMP.extension(TAG, '0.1', AMP => {
  AMP.registerElement(TAG, AmpPanZoom, CSS);
});
