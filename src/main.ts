import { Plugin } from "obsidian";

/**
 * Vault Waystation 的插件入口。
 *
 * 本类只负责按 Obsidian 的生命周期把各模块接起来；采集、上报与界面分别在自己的模块中实现。
 */
export default class WaystationPlugin extends Plugin {
  /** 插件加载时建立后台任务与界面。 */
  override onload(): void {
    // 界面与节奏在各自模块就绪后接入，此处先保证入口可加载。
  }

  /** 插件卸载时停止后台任务并释放资源。 */
  override onunload(): void {
    // 与 onload 对应：接入的资源在这里释放。
  }
}
