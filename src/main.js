import naive from "naive-ui";
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import router from "./router";
import "@arco-design/web-vue/dist/arco.css";
import "virtual:uno.css";
import "./assets/styles/global.scss";

// 创建应用实例
const app = createApp(App);

// 使用插件
app.use(createPinia());
app.use(router);
app.use(naive);

// Vue SFC 编译器默认把 <n-tabs> 编译成 resolveComponent("n-tabs")（kebab-case）
// 但 NaiveUI app.use() 注册的是 PascalCase 名字（NTabs）
// resolveComponent 不会自动互转，导致组件解析失败、退化成原生 HTML 标签
// 这里手动注册 kebab-case 别名让所有 <n-xxx> 标签能正确 resolve
const naiveKebabMap = {
  // 从 PascalCase 转 kebab-case
  NTabs: 'n-tabs',
  NTabPane: 'n-tab-pane',
  NButton: 'n-button',
  NCard: 'n-card',
  NCheckbox: 'n-checkbox',
  NRadioGroup: 'n-radio-group',
  NRadioButton: 'n-radio-button',
  NDataTable: 'n-data-table',
  NTag: 'n-tag',
  NSpace: 'n-space',
  NGrid: 'n-grid',
  NGridItem: 'n-grid-item',
  NModal: 'n-modal',
  NInput: 'n-input',
  NSelect: 'n-select',
  NSlider: 'n-slider',
  NProgress: 'n-progress',
  NSpin: 'n-spin',
  NScrollbar: 'n-scrollbar',
  NDivider: 'n-divider',
  NIcon: 'n-icon',
  NAlert: 'n-alert',
  NTooltip: 'n-tooltip',
  NPopover: 'n-popover',
  NPopconfirm: 'n-popconfirm',
  NMessageProvider: 'n-message-provider',
  NNotificationProvider: 'n-notification-provider',
  NConfigProvider: 'n-config-provider',
  NLayout: 'n-layout',
  NLayoutSider: 'n-layout-sider',
  NLayoutHeader: 'n-layout-header',
  NLayoutContent: 'n-layout-content',
  NLayoutFooter: 'n-layout-footer',
  NMenu: 'n-menu',
  NMenuItem: 'n-menu-item',
  NSubmenu: 'n-submenu',
  NDropdown: 'n-dropdown',
  NAvatar: 'n-avatar',
  NBadge: 'n-badge',
  NBaseLoading: 'n-base-loading',
  NBackTop: 'n-back-top',
  NCascader: 'n-cascader',
  NColorPicker: 'n-color-picker',
  NDatePicker: 'n-date-picker',
  NTimePicker: 'n-time-picker',
  NDynamicInput: 'n-dynamic-input',
  NDynamicTags: 'n-dynamic-tags',
  NForm: 'n-form',
  NFormItem: 'n-form-item',
  NInputGroup: 'n-input-group',
  NInputNumber: 'n-input-number',
  NInputTag: 'n-input-tag',
  NRate: 'n-rate',
  NSwitch: 'n-switch',
  NUpload: 'n-upload',
  NUploadDragger: 'n-upload-dragger',
  NUploadFileList: 'n-upload-file-list',
  NAutoComplete: 'n-auto-complete',
  NEllipsis: 'n-ellipsis',
  NFlow: 'n-flow',
  NHighlight: 'n-highlight',
  NImage: 'n-image',
  NImageGroup: 'n-image-group',
  NList: 'n-list',
  NListItem: 'n-list-item',
  NThing: 'n-thing',
  NCarousel: 'n-carousel',
  NCarouselItem: 'n-carousel-item',
  NPagination: 'n-pagination',
  NSteps: 'n-steps',
  NStep: 'n-step',
  NTimeline: 'n-timeline',
  NTimelineItem: 'n-timeline-item',
  NTree: 'n-tree',
  NVirtualList: 'n-virtual-list',
};
for (const [pascal, kebab] of Object.entries(naiveKebabMap)) {
  const comp = naive[pascal];
  if (comp && !app.component(kebab)) {
    app.component(kebab, comp);
  }
}

// 全局主题应用：从 localStorage 读取并设置 data-theme 属性
const applyTheme = () => {
  const saved = localStorage.getItem("theme") || "auto";
  if (saved === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else if (saved === "light") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    const prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark)
      document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");

    // 跟随系统变更
    if (window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", (e) => {
          const t = localStorage.getItem("theme") || "auto";
          if (t === "auto") {
            if (e.matches)
              document.documentElement.setAttribute("data-theme", "dark");
            else document.documentElement.removeAttribute("data-theme");
          }
        });
    }
  }
};

applyTheme();

// 挂载应用
app.mount("#app");
