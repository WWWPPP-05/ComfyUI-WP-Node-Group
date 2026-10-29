import time
import torch
import comfy.model_management
from aiohttp import web
from nodes import PreviewImage
from server import PromptServer
from threading import Event
import comfy.model_management

class ImageSelectorCancelled(Exception):
    pass

def get_selector_storage():
    """获取图像选择器的共享存储空间"""
    if not hasattr(PromptServer.instance, '_wp_selector_node_data'):
        PromptServer.instance._wp_selector_node_data = {}
    return PromptServer.instance._wp_selector_node_data

class ImageSelector(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "mode": (["always_pause", "keep_last_selection", "passthrough"], {"default": "always_pause"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO"
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("selected_images", "selected_indices")
    FUNCTION = "select_image"
    CATEGORY = "🐳 WP_Node"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = (True, False)
    INPUT_IS_LIST = True
    
    @classmethod
    def IS_CHANGED(cls, images, **kwargs):
        return float(time.time())
    
    def select_image(self, images, mode, prompt=None, unique_id=None, extra_pnginfo=None):
        try:
            node_id = str(unique_id[0]) if isinstance(unique_id, list) else str(unique_id)
            actual_mode = mode[0] if isinstance(mode, list) else mode
            
            # 获取共享存储空间
            node_data = get_selector_storage()
            
            image_list = []
            if isinstance(images, list):
                for img in images:
                    if isinstance(img, torch.Tensor):
                        if len(img.shape) == 4:
                            for i in range(img.shape[0]):
                                image_list.append(img[i:i+1])
                        elif len(img.shape) == 3:
                            image_list.append(img.unsqueeze(0))
            elif isinstance(images, torch.Tensor):
                if len(images.shape) == 4:
                    for i in range(images.shape[0]):
                        image_list.append(images[i:i+1])
                elif len(images.shape) == 3:
                    image_list.append(images.unsqueeze(0))
                else:
                    raise ValueError(f"不支持的图像维度: {images.shape}")
            else:
                raise ValueError(f"不支持的输入类型: {type(images)}")
            
            preview_images = []
            for i, img in enumerate(image_list):
                try:
                    result = self.save_images(images=img, prompt=prompt)
                    if 'ui' in result and 'images' in result['ui']:
                        preview_images.extend(result['ui']['images'])
                except Exception as e:
                    continue
            
            try:
                PromptServer.instance.send_sync("wp_image_selector_update", {
                    "id": node_id, 
                    "urls": preview_images
                })
            except Exception as e:
                pass
            
            if actual_mode == "passthrough":
                self.cleanup_session_data(node_id)
                all_indices = ','.join(str(i) for i in range(len(image_list)))
                return {"result": (image_list, all_indices)}
            
            if actual_mode == "keep_last_selection":
                if node_id in node_data and "last_selection" in node_data[node_id]:
                    last_selection = node_data[node_id]["last_selection"]
                    if last_selection and len(last_selection) > 0:
                        valid_indices = [idx for idx in last_selection if 0 <= idx < len(image_list)]
                        if valid_indices:
                            try:
                                PromptServer.instance.send_sync("wp_image_selector_selection", {
                                    "id": node_id,
                                    "selected_indices": valid_indices
                                })
                            except Exception as e:
                                pass
                            self.cleanup_session_data(node_id)
                            indices_str = ','.join(str(i) for i in valid_indices)
                            return {"result": ([image_list[idx] for idx in valid_indices], indices_str)}
            
            if node_id in node_data:
                del node_data[node_id]
            
            event = Event()
            node_data[node_id] = {
                "event": event,
                "selected_indices": None,
                "images": image_list,
                "total_count": len(image_list),
                "cancelled": False
            }
            
            while node_id in node_data:
                node_info = node_data[node_id]
                if node_info.get("cancelled", False):
                    self.cleanup_session_data(node_id)
                    raise ImageSelectorCancelled("用户取消选择")

                if "selected_indices" in node_info and node_info["selected_indices"] is not None:
                    break

                # 响应主程序全局中断（"结束运行"按钮）：新前端不经过 api.interrupt 拦截，必须由后端主动检查
                if comfy.model_management.processing_interrupted():
                    self.cleanup_session_data(node_id)
                    try:
                        PromptServer.instance.send_sync("wp_image_selector_selection", {
                            "id": node_id,
                            "selected_indices": []
                        })
                    except Exception:
                        pass
                    comfy.model_management.throw_exception_if_processing_interrupted()

                time.sleep(0.1)

            if node_id in node_data:
                node_info = node_data[node_id]
                selected_indices = node_info.get("selected_indices")
                
                if selected_indices is not None and len(selected_indices) > 0:
                    valid_indices = [idx for idx in selected_indices if 0 <= idx < len(image_list)]
                    if valid_indices:
                        selected_images = [image_list[idx] for idx in valid_indices]
                        
                        if node_id not in node_data:
                            node_data[node_id] = {}
                        node_data[node_id]["last_selection"] = valid_indices
                        
                        self.cleanup_session_data(node_id)
                        indices_str = ','.join(str(i) for i in valid_indices)
                        return {"result": (selected_images, indices_str)}
                    else:
                        self.cleanup_session_data(node_id)
                        return {"result": ([image_list[0]] if len(image_list) > 0 else [], "0" if len(image_list) > 0 else "")}
                else:
                    self.cleanup_session_data(node_id)
                    return {"result": ([image_list[0]] if len(image_list) > 0 else [], "0" if len(image_list) > 0 else "")}
            else:
                return {"result": ([image_list[0]] if len(image_list) > 0 else [], "0" if len(image_list) > 0 else "")}
            
        except ImageSelectorCancelled:
            raise comfy.model_management.InterruptProcessingException()
        except Exception as e:
            node_data = get_selector_storage()
            if node_id in node_data:
                self.cleanup_session_data(node_id)
            if 'image_list' in locals() and len(image_list) > 0:
                return {"result": ([image_list[0]], "0")}
            else:
                return {"result": ([], "")}

    def cleanup_session_data(self, node_id):
        """清理会话数据"""
        node_data = get_selector_storage()
        if node_id in node_data:
            session_keys = ["event", "selected_indices", "images", "total_count", "cancelled"]
            for key in session_keys:
                if key in node_data[node_id]:
                    del node_data[node_id][key]

@PromptServer.instance.routes.post("/wp_image_selector/select")
async def select_image_handler(request):
    try:
        data = await request.json()
        node_id = data.get("node_id")
        selected_indices = data.get("selected_indices", [])
        action = data.get("action")
        
        # 获取共享存储空间
        node_data = get_selector_storage()
        
        if node_id not in node_data:
            return web.json_response({"success": False, "error": "节点数据不存在"})
        
        try:
            node_info = node_data[node_id]
            
            if "total_count" not in node_info:
                return web.json_response({"success": False, "error": "节点已完成处理"})
            
            if action == "cancel":
                node_info["cancelled"] = True
                node_info["selected_indices"] = []
            elif action == "select" and isinstance(selected_indices, list):
                valid_indices = [idx for idx in selected_indices if isinstance(idx, int) and 0 <= idx < node_info["total_count"]]
                if valid_indices:
                    node_info["selected_indices"] = valid_indices
                    node_info["cancelled"] = False
                else:
                    return web.json_response({"success": False, "error": "选择索引无效"})
            else:
                return web.json_response({"success": False, "error": "无效操作"})
            
            node_info["event"].set()
            return web.json_response({"success": True})
            
        except Exception as e:
            if node_id in node_data and "event" in node_data[node_id]:
                node_data[node_id]["event"].set()
            return web.json_response({"success": False, "error": "处理失败"})

    except Exception as e:
        return web.json_response({"success": False, "error": "请求失败"})

NODE_CLASS_MAPPINGS = {
    "WP_ImageSelector": ImageSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WP_ImageSelector": "🐳 WP 图片选择器",
} 