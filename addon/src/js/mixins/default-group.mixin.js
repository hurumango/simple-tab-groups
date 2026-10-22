import * as Groups from '/js/groups.js';

export default {
    data() {
        return {
            openEditDefaultGroup: false, //[cite: 10]
        };
    },
    methods: {
        async openDefaultGroup() {
            try {
                const defaults = await Groups.getDefaults(); //[cite: 10]
                this.defaultGroup = defaults.defaultGroup;
                this.openEditDefaultGroup = true; //[cite: 10]
            } catch (error) {
                console.error("Failed to load default group settings:", error);
            }
        },

        saveDefaultGroup(changes) {
            this.openEditDefaultGroup = false; //[cite: 10]
            this.sendMessageModule('Groups.saveDefault', changes); //[cite: 10]
        },
    },
}
