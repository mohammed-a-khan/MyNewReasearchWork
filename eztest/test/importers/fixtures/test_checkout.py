import time
import unittest

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select, WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE_URL = "http://localhost:4600"


class CheckoutTest(unittest.TestCase):
    def setUp(self):
        self.driver = webdriver.Chrome()
        self.driver.implicitly_wait(5)
        self.driver.get(BASE_URL + "/login")

    def test_login_and_order(self):
        driver = self.driver
        driver.find_element(By.ID, "username").send_keys("bob")
        driver.find_element(By.ID, "password").send_keys("Builder#2" + Keys.RETURN)
        WebDriverWait(driver, 10).until(EC.url_contains("/dashboard"))
        assert "Dashboard" in driver.title
        driver.find_element(By.LINK_TEXT, "New order").click()
        Select(driver.find_element(By.ID, "product")).select_by_visible_text("Widget (19.99)")
        qty = driver.find_element(By.CSS_SELECTOR, "#qty")
        qty.clear()
        qty.send_keys("3")
        driver.find_element_by_xpath("//button[text()='Submit order']").click()
        time.sleep(1)
        self.assertIn("created", driver.page_source)
        self.assertEqual(driver.find_element(By.CSS_SELECTOR, "[data-testid=order-total]").text, "59.97")
        assert driver.find_element(By.ID, "download-invoice").is_displayed(), "invoice link missing"
        with open("x.txt") as f:
            f.write("done")

    def tearDown(self):
        self.driver.quit()


if __name__ == "__main__":
    unittest.main()
