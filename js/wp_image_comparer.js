import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ═══════════════════════════════════════════════
// 🐳 WP 图像对比 · 前端交互（仅在节点内滑动对比）
// ═══════════════════════════════════════════════

function imageDataToUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder}${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}

function initComparer(node) {
    node._comparerImages = [];
    node._selected = [];
    node.isPointerOver = false;
    node.pointerOverPos = [0, 0];
    node.setSize([512, 512]); // 新建节点默认尺寸
}

function setSelected(node, selected) {
    node._comparerImages.forEach((d) => (d.selected = false));
    for (const sel of selected) {
        if (!sel.img) {
            sel.img = new Image();
            sel.img.src = sel.url;
            sel.img.onload = () => node.setDirtyCanvas(true, true);
        }
        sel.selected = true;
    }
    node._selected = selected;
}

function drawImage(ctx, node, image, cropX) {
    if (!image || !image.img || !image.img.naturalWidth || !image.img.naturalHeight) return;

    const nodeWidth = node.size[0];
    const titleH = 30; // LiteGraph 标题栏高度，图像绘制在标题栏下方
    const height = node.size[1] - titleH;
    const imageAspect = image.img.naturalWidth / image.img.naturalHeight;
    const widgetAspect = nodeWidth / height;

    let targetWidth, targetHeight, offsetX = 0;
    if (imageAspect > widgetAspect) {
        targetWidth = nodeWidth;
        targetHeight = nodeWidth / imageAspect;
    } else {
        targetHeight = height;
        targetWidth = height * imageAspect;
        offsetX = (nodeWidth - targetWidth) / 2;
    }
    const widthMultiplier = image.img.naturalWidth / targetWidth;

    const sourceX = 0;
    const sourceY = 0;
    const sourceWidth = cropX != null ? (cropX - offsetX) * widthMultiplier : image.img.naturalWidth;
    const sourceHeight = image.img.naturalHeight;
    const destX = (nodeWidth - targetWidth) / 2;
    const destY = titleH + (height - targetHeight) / 2;
    const destWidth = cropX != null ? cropX - offsetX : targetWidth;
    const destHeight = targetHeight;

    ctx.save();
    if (cropX != null) {
        ctx.beginPath();
        ctx.rect(destX, destY, destWidth, destHeight);
        ctx.clip();
    }
    ctx.drawImage(image.img, sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight);

    // 滑动分割线
    if (cropX != null && cropX >= destX && cropX <= destX + targetWidth) {
        ctx.beginPath();
        ctx.moveTo(cropX, destY);
        ctx.lineTo(cropX, destY + destHeight);
        ctx.strokeStyle = "#662ad5";
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    ctx.restore();
}

function drawComparer(node, ctx) {
    if (!node._selected || node._selected.length === 0) return;

    drawImage(ctx, node, node._selected[0]);
    if (node.isPointerOver && node._selected[1]) {
        drawImage(ctx, node, node._selected[1], node.pointerOverPos[0]);
    }
}

app.registerExtension({
    name: "WP_Node.ImageComparer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "WP_ImageComparer") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            initComparer(this);
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            if (onExecuted) onExecuted.apply(this, arguments);

            const out = message || {};
            // 兼容标准预览返回（images 键）
            if (out.images != null) {
                const imgs = (out.images || []).map((d, i) => ({
                    name: i === 0 ? "A" : "B",
                    selected: true,
                    url: imageDataToUrl(d),
                }));
                this._comparerImages = imgs;
                setSelected(this, imgs);
                this.setDirtyCanvas(true, true);
                return;
            }

            const a = out.a_images || [];
            const b = out.b_images || [];
            if (a.length + b.length === 0) return;

            const multiple = a.length + b.length > 2;
            const imagesToChoose = [];
            a.forEach((d, i) => {
                imagesToChoose.push({
                    name: a.length > 1 || multiple ? `A${i + 1}` : "A",
                    selected: i === 0,
                    url: imageDataToUrl(d),
                });
            });
            b.forEach((d, i) => {
                imagesToChoose.push({
                    name: b.length > 1 || multiple ? `B${i + 1}` : "B",
                    selected: i === 0,
                    url: imageDataToUrl(d),
                });
            });

            this._comparerImages = imagesToChoose;
            const aImg = imagesToChoose.find((d) => d.name.startsWith("A"));
            const bImg = imagesToChoose.find((d) => d.name.startsWith("B"));
            const finalSel = [];
            if (aImg) finalSel.push(aImg);
            if (bImg) finalSel.push(bImg);
            setSelected(this, finalSel);
            this.setDirtyCanvas(true, true);
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            drawComparer(this, ctx);
        };

        const onMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (event, pos, canvas) {
            if (onMouseMove) onMouseMove.apply(this, arguments);
            // LiteGraph 传入的 pos 已是节点内部坐标（相对节点左上角），直接使用
            this.pointerOverPos = [...pos];
            this.isPointerOver = true;
            this.setDirtyCanvas(true, false);
        };

        const onMouseLeave = nodeType.prototype.onMouseLeave;
        nodeType.prototype.onMouseLeave = function (event) {
            if (onMouseLeave) onMouseLeave.apply(this, arguments);
            this.isPointerOver = false;
            this.setDirtyCanvas(true, false);
        };
    },
});